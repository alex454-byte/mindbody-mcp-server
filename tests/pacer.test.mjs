import test from "node:test";
import assert from "node:assert/strict";
import { MboPacer, PacerBusyError } from "../dist/mbo/pacer.js";

/** Deterministic clock — real timers would make these slow and flaky. */
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

test("two calls to the SAME site are separated by at least the minimum gap", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 600, now: c.now, sleep: c.sleep });
  const at = [];
  await pacer.run("111", async () => at.push(c.value));
  await pacer.run("111", async () => at.push(c.value));
  assert.ok(at[1] - at[0] >= 600, `expected >=600ms gap, got ${at[1] - at[0]}`);
});

test("calls to DIFFERENT sites are not delayed by each other", async () => {
  // Mindbody's limit is per SiteId — pacing across unrelated sites would be
  // pure latency for no protection.
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 600, now: c.now, sleep: c.sleep });
  const at = [];
  await pacer.run("111", async () => at.push(c.value));
  await pacer.run("222", async () => at.push(c.value));
  assert.equal(at[1] - at[0], 0);
});

test("the timestamp is stamped BEFORE the call — CONCURRENT callers cannot all fire at once", async () => {
  // Stamping after would let N concurrent requests for one site each observe
  // "no recent call" and burst together — the exact failure this prevents.
  //
  // This test MUST be concurrent. An earlier sequential version passed even
  // with the bug reintroduced, because with sequential awaits the gap is
  // satisfied either way — it proved nothing. Verified by reverting to
  // stamp-after and confirming THIS version fails.
  const pacer = new MboPacer({ minGapMs: 600, maxWaitMs: 30_000 });
  const started = [];
  const slowCall = async () => {
    started.push(Date.now());
    await new Promise((r) => setTimeout(r, 120)); // the MBO call takes time
  };

  // Fire both WITHOUT awaiting the first — the real concurrency scenario.
  await Promise.all([pacer.run("111", slowCall), pacer.run("111", slowCall)]);

  assert.equal(started.length, 2);
  const gap = started[1] - started[0];
  assert.ok(gap >= 550, `concurrent calls to one site must still be paced apart, got ${gap}ms`);
});

test("a concurrency slot is released even when the call THROWS", async () => {
  // A leaked slot is silent and only surfaces later as inexplicable "busy"
  // errors, so this is worth pinning explicitly.
  const pacer = new MboPacer({ minGapMs: 0, maxConcurrent: 1 });
  await assert.rejects(() => pacer.run("111", async () => { throw new Error("MBO 500"); }), /MBO 500/);
  assert.equal(pacer.stats().inFlight, 0);
  await assert.doesNotReject(() => pacer.run("111", async () => "ok"));
});

test("waiting is BOUNDED — it fails clearly rather than hanging until the client times out", async () => {
  // A silent hang and a clear error both deny the user an answer, but only
  // one of them is diagnosable.
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 60_000, maxWaitMs: 1000, now: c.now, sleep: c.sleep });
  await pacer.run("111", async () => "first");
  await assert.rejects(() => pacer.run("111", async () => "second"), PacerBusyError);
});

test("the busy error explains WHY, not just that it failed", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 60_000, maxWaitMs: 500, now: c.now, sleep: c.sleep });
  await pacer.run("111", async () => "first");
  await assert.rejects(
    () => pacer.run("111", async () => "second"),
    /shares one API account|per-site limit/i,
  );
});

test("prune drops stale sites but keeps ones still inside their gap", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 600, now: c.now, sleep: c.sleep });
  await pacer.run("111", async () => "x");
  assert.equal(pacer.stats().trackedSites, 1);
  c.advance(100); // still well inside the gap
  pacer.prune();
  assert.equal(pacer.stats().trackedSites, 1, "pruning here would allow an immediate second call");
  c.advance(10_000);
  pacer.prune();
  assert.equal(pacer.stats().trackedSites, 0);
});

test("the pacer returns the call's value unchanged", async () => {
  const pacer = new MboPacer({ minGapMs: 0 });
  assert.deepEqual(await pacer.run("111", async () => ({ ok: true })), { ok: true });
});

// ---------------------------------------------------------------------------
// Graduated per-site throttle: widen the gap to stop one user over-taxing
// a single site.
// ---------------------------------------------------------------------------

test("light use of a site stays FAST — the wide gap does not kick in early", async () => {
  // A flat 5s would make ordinary questions painful; three tool calls would
  // be 15s of pure waiting. Graduated pacing has to stay cheap for normal use
  // or it is a worse product for everyone to defend against a rare case.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, sustainedAfterCalls: 20, sustainedWindowMs: 60_000,
    sustainedGapMs: 5000, now: c.now, sleep: c.sleep,
  });
  for (let i = 0; i < 5; i++) await pacer.run("111", async () => "x");
  assert.equal(pacer.gapFor("111"), 600, "5 calls is interactive use, not abuse");
});

test("sustained hammering of ONE site widens its gap to 5s", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, sustainedAfterCalls: 20, sustainedWindowMs: 60_000,
    sustainedGapMs: 5000, now: c.now, sleep: c.sleep,
  });
  for (let i = 0; i < 20; i++) await pacer.run("111", async () => "x");
  assert.equal(pacer.gapFor("111"), 5000);
});

test("the throttle is PER SITE — hammering one does not slow another", async () => {
  // The whole point is protecting a specific site's quota, not punishing
  // unrelated ones.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, sustainedAfterCalls: 20, sustainedWindowMs: 60_000,
    sustainedGapMs: 5000, now: c.now, sleep: c.sleep,
  });
  for (let i = 0; i < 20; i++) await pacer.run("111", async () => "x");
  assert.equal(pacer.gapFor("111"), 5000);
  assert.equal(pacer.gapFor("222"), 600, "an untouched site must stay fast");
});

test("the site recovers to normal pace once it goes quiet", async () => {
  // Throttling must be a response to CURRENT load, not a permanent penalty.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, sustainedAfterCalls: 20, sustainedWindowMs: 60_000,
    sustainedGapMs: 5000, now: c.now, sleep: c.sleep,
  });
  for (let i = 0; i < 20; i++) await pacer.run("111", async () => "x");
  assert.equal(pacer.gapFor("111"), 5000);
  c.advance(61_000); // window elapses
  assert.equal(pacer.gapFor("111"), 600);
});

test("the widened gap is actually ENFORCED, not just reported", async () => {
  // gapFor() returning 5000 is worthless if run() still paces at 600ms.
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 600, sustainedAfterCalls: 3, sustainedWindowMs: 60_000,
    sustainedGapMs: 5000, maxWaitMs: 30_000, now: c.now, sleep: c.sleep,
  });
  for (let i = 0; i < 3; i++) await pacer.run("111", async () => "x");
  const before = c.value;
  await pacer.run("111", async () => "x");
  assert.ok(c.value - before >= 5000, `expected the 5s gap to be waited, got ${c.value - before}ms`);
});

// ---------------------------------------------------------------------------
// Burst allowance (opt-in).
// The first `burstCalls` calls to a site inside the sustained window skip the
// min gap entirely, so a short interactive question is not throttled at all;
// pacing then resumes, and the 5s sustained escalation is untouched.
// ---------------------------------------------------------------------------

test("the first burstCalls calls to a site are NOT gapped", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 200, burstCalls: 3, now: c.now, sleep: c.sleep });
  const at = [];
  for (let i = 0; i < 3; i++) await pacer.run("111", async () => at.push(c.value));
  assert.equal(at[2] - at[0], 0, `burst calls should not wait, spread was ${at[2] - at[0]}ms`);
});

test("after the burst, the normal min gap applies", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 200, burstCalls: 3, now: c.now, sleep: c.sleep });
  const at = [];
  for (let i = 0; i < 5; i++) await pacer.run("111", async () => at.push(c.value));
  assert.ok(at[3] - at[2] >= 200, `call 4 should be gapped, got ${at[3] - at[2]}ms`);
  assert.ok(at[4] - at[3] >= 200, `call 5 should be gapped, got ${at[4] - at[3]}ms`);
});

test("the sustained escalation still fires after heavy use, burst or not", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({
    minGapMs: 200, burstCalls: 3, sustainedAfterCalls: 6, sustainedGapMs: 5000,
    now: c.now, sleep: c.sleep,
  });
  const at = [];
  for (let i = 0; i < 8; i++) await pacer.run("111", async () => at.push(c.value));
  assert.ok(at[7] - at[6] >= 5000, `heavy use must escalate to the sustained gap, got ${at[7] - at[6]}ms`);
});

test("burst defaults to 0 — existing behavior unchanged when not opted in", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 600, now: c.now, sleep: c.sleep });
  const at = [];
  await pacer.run("111", async () => at.push(c.value));
  await pacer.run("111", async () => at.push(c.value));
  assert.ok(at[1] - at[0] >= 600, "no-burst pacers must keep the old gap from call 2");
});

test("the burst is per-site, and resets when the window expires", async () => {
  const c = fakeClock();
  const pacer = new MboPacer({ minGapMs: 200, burstCalls: 2, sustainedWindowMs: 60_000, now: c.now, sleep: c.sleep });
  const at = [];
  await pacer.run("111", async () => at.push(c.value));
  await pacer.run("222", async () => at.push(c.value)); // different site: its own burst
  assert.equal(at[1] - at[0], 0);
  c.advance(61_000); // window expires -> burst replenishes
  const t0 = c.value;
  await pacer.run("111", async () => at.push(c.value));
  assert.equal(at[2] - t0, 0, "an idle site earns its burst back");
});
