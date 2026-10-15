/**
 * Smart backoff + pause, and the per-caller single-flight limit.
 *
 * Two halves on top of plain pacing:
 *   - smart pause — when Mindbody actually pushes back (429), stop sending to
 *     that site for a while instead of continuing at the normal gap.
 *     src/mbo/client.ts already retries an individual request; this is about
 *     the NEXT requests, which it knows nothing about.
 *   - per-caller single-flight — two sessions with the same caller key must
 *     not double the outbound rate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MboPacer, PacerBusyError } from "../dist/mbo/pacer.js";
import { MboClient } from "../dist/mbo/client.js";

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
    get value() {
      return now;
    },
  };
}

/** Shaped like MboRateLimitError from src/mbo/errors.ts. */
function rateLimitError() {
  const e = new Error("429 from /sale/sales after 3 attempts");
  e.name = "MboRateLimitError";
  e.statusCode = 429;
  return e;
}

function notFoundError() {
  const e = new Error("Mindbody returned 404");
  e.name = "MboError";
  e.statusCode = 404;
  return e;
}

// ---------------------------------------------------------------------------
// Smart pause on real pushback
// ---------------------------------------------------------------------------

test("a 429 that escapes the client's own retries PAUSES that site", async () => {
  // The client already retried this request and still got 429 — the site is
  // genuinely over its limit. Continuing at the normal 600ms gap would keep
  // it there.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, basePauseMs: 5000, maxWaitMs: 30_000, now: c.now, sleep: c.sleep,
  });
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));

  const before = c.value;
  await pacer.run("111", async () => "ok");
  assert.ok(c.value - before >= 5000, `expected a >=5s pause after a 429, waited ${c.value - before}ms`);
});

test("the error is RE-THROWN, not swallowed by the pause bookkeeping", async () => {
  // Recording the 429 must not hide it — the caller still needs to know the
  // request failed.
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 0, now: c.now, sleep: c.sleep });
  await assert.rejects(
    () => pacer.run("111", async () => { throw rateLimitError(); }),
    /429 from/,
  );
});

test("repeated 429s escalate the pause", async () => {
  // One 429 is a blip; three in a row means backing off further is the only
  // thing that will help.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, basePauseMs: 5000, maxWaitMs: 60_000, now: c.now, sleep: c.sleep,
  });
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  const firstPause = pacer.pauseRemainingMs("111");

  c.advance(firstPause); // serve out the first pause
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  const secondPause = pacer.pauseRemainingMs("111");

  assert.ok(secondPause > firstPause, `expected escalation, got ${firstPause} then ${secondPause}`);
});

test("a success CLEARS the escalation — backoff is not a permanent penalty", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 0, basePauseMs: 5000, maxWaitMs: 60_000, now: c.now, sleep: c.sleep,
  });
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  c.advance(60_000);
  await pacer.run("111", async () => "ok"); // recovered

  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  assert.equal(pacer.pauseRemainingMs("111"), 5000, "a fresh 429 after a success should start at the base pause");
});

test("a NON-rate-limit error does not pause the site", async () => {
  // A 404 from one bad query must not brick that site for every other
  // user for the next five seconds.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 0, basePauseMs: 5000, maxWaitMs: 30_000, now: c.now, sleep: c.sleep,
  });
  await assert.rejects(() => pacer.run("111", async () => { throw notFoundError(); }));
  assert.equal(pacer.pauseRemainingMs("111"), 0);
});

test("the pause is PER SITE — one site's 429 does not stall another", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 0, basePauseMs: 5000, maxWaitMs: 30_000, now: c.now, sleep: c.sleep,
  });
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  assert.ok(pacer.pauseRemainingMs("111") > 0);
  assert.equal(pacer.pauseRemainingMs("222"), 0);

  const before = c.value;
  await pacer.run("222", async () => "ok");
  assert.equal(c.value - before, 0, "an unrelated site must not wait out another site's pause");
});

test("a pause longer than the bounded wait fails FAST with a clear reason", async () => {
  // Better to say "paused, try again" than to hang until the client times out.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 0, basePauseMs: 30_000, maxWaitMs: 5000, now: c.now, sleep: c.sleep,
  });
  await assert.rejects(() => pacer.run("111", async () => { throw rateLimitError(); }));
  await assert.rejects(() => pacer.run("111", async () => "ok"), PacerBusyError);
  await assert.rejects(() => pacer.run("111", async () => "ok"), /rate limit|backing off|paused/i);
});

// ---------------------------------------------------------------------------
// Per-caller single-flight
// ---------------------------------------------------------------------------

test("one caller cannot have two MBO calls in flight at once", async () => {
  // Two agents in one terminal, same login: without this they interleave and
  // double the outbound rate while each looks individually well-behaved.
  const pacer = new MboPacer({ minGapMs: 0, maxWaitMs: 30_000 });
  let concurrent = 0;
  let peak = 0;
  const call = async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 60));
    concurrent--;
  };

  await Promise.all([
    pacer.run("111", call, { callerKey: "sub-alice" }),
    pacer.run("111", call, { callerKey: "sub-alice" }),
    pacer.run("111", call, { callerKey: "sub-alice" }),
  ]);

  assert.equal(peak, 1, `same-caller calls must serialize, saw ${peak} in flight`);
});

test("DIFFERENT callers are not serialized by each other", async () => {
  // The limit exists to stop one person multiplying their own rate, not to
  // make colleagues queue behind each other.
  const pacer = new MboPacer({ minGapMs: 0, maxWaitMs: 30_000 });
  let concurrent = 0;
  let peak = 0;
  const call = async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 60));
    concurrent--;
  };

  await Promise.all([
    pacer.run("111", call, { callerKey: "sub-alice" }),
    pacer.run("222", call, { callerKey: "sub-bob" }),
  ]);

  assert.equal(peak, 2, "two different people should proceed in parallel");
});

test("a caller's single-flight slot is released when the call THROWS", async () => {
  // A leaked per-caller slot would lock that caller out until restart.
  const pacer = new MboPacer({ minGapMs: 0, maxWaitMs: 2000 });
  await assert.rejects(
    () => pacer.run("111", async () => { throw new Error("boom"); }, { callerKey: "sub-alice" }),
    /boom/,
  );
  await assert.doesNotReject(() => pacer.run("111", async () => "ok", { callerKey: "sub-alice" }));
});

test("calls with no caller key still work", async () => {
  // Calls without a caller identity must not be blocked by a limit keyed on one.
  const pacer = new MboPacer({ minGapMs: 0 });
  assert.equal(await pacer.run("111", async () => "ok"), "ok");
});

test("a caller key reaches the HTTP client layer", async () => {
  const pacer = new MboPacer({ minGapMs: 0, maxWaitMs: 30_000 });
  let issued = false;
  let concurrent = 0;
  let peak = 0;
  const client = new MboClient({
    apiKey: "k",
    username: "u",
    password: "p",
    baseUrl: "https://api.example.test/public/v6",
    pacer,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/usertoken/issue")) {
        issued = true;
        return new Response(JSON.stringify({ AccessToken: "tok", ExpiresIn: 3600 }));
      }
      assert.equal(issued, true);
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 60));
      concurrent--;
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  // Prime the shared token cache, so the measurement below covers the two
  // concurrent API reads, not two simultaneous token issuances.
  await client.get("111", "/class/classes");
  const callerClient = client.forCaller("sub-alice");

  await Promise.all([
    callerClient.get("111", "/class/classes"),
    callerClient.get("111", "/class/classes"),
  ]);

  assert.equal(peak, 1, `same caller's HTTP requests must serialize, saw ${peak} in flight`);
});
