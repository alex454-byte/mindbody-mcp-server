/**
 * The per-request timeout must cover only the HTTP fetch, NOT the pacer wait.
 *
 * Under heavy pacing (5s gaps, concurrency 1), a call queued behind many
 * others can wait >30s in the pacer. If the 30s request timeout started BEFORE
 * the pacer wait, it would abort the call before it ever hit the network. The
 * pacer already bounds its own queue wait (maxWaitMs); the request timeout
 * should bound the FETCH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MboClient } from "../dist/mbo/client.js";
import { MboPacer } from "../dist/mbo/pacer.js";

function tokenAwareFetch(onCall) {
  return async (url, init) => {
    if (String(url).includes("issue")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ AccessToken: "t", TokenType: "Bearer" }) };
    }
    return onCall(url, init);
  };
}

test("a call that WAITS in the pacer longer than the request timeout, but fetches instantly, still succeeds", async () => {
  // Two calls, one slot, a 300ms gap -> the second waits ~300ms in the pacer.
  // Request timeout is 100ms. If the timeout covered the wait, the second call
  // would abort; it must not, because the fetch itself is instant.
  const pacer = new MboPacer({ minGapMs: 300, sustainedGapMs: 300, maxConcurrent: 1, maxWaitMs: 60_000 });
  const fetchImpl = tokenAwareFetch(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: 1 }) }));
  const client = new MboClient({ apiKey: "k", username: "u", password: "p", baseUrl: "https://x.example/public/v6", fetchImpl, pacer, requestTimeoutMs: 100 });

  const results = await Promise.allSettled([
    client.get("/class/classes", { siteId: "111" }),
    client.get("/class/classes", { siteId: "111" }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled", `second call aborted: ${results[1].reason?.message}`);
});

test("a genuinely slow FETCH is still aborted by the request timeout", async () => {
  // The timeout must still do its job on a hung network call.
  const fetchImpl = tokenAwareFetch(async (url, init) => {
    await new Promise((r, rej) => {
      const t = setTimeout(() => r({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) }), 5000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("This operation was aborted")); });
    });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
  });
  const client = new MboClient({ apiKey: "k", username: "u", password: "p", baseUrl: "https://x.example/public/v6", fetchImpl, requestTimeoutMs: 80 });
  await assert.rejects(() => client.get("/class/classes", { siteId: "111" }), /aborted|failed/i);
});
