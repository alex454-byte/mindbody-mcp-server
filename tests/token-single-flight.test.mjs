/**
 * MBO token single-flight: on a cold site cache, concurrent calls must share
 * one POST /usertoken/issue instead of each logging in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MboClient } from "../dist/mbo/client.js";

function makeClient(counters) {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/usertoken/issue")) {
      counters.tokenIssues += 1;
      await new Promise((r) => setTimeout(r, 20)); // let the others pile up
      return { ok: true, status: 200, json: async () => ({ AccessToken: "T", ExpiresIn: 3600 }), text: async () => "" };
    }
    counters.dataCalls += 1;
    return { ok: true, status: 200, json: async () => ({ Items: [] }), text: async () => "" };
  };
  const client = new MboClient({
    apiKey: "k", username: "u", password: "p", baseUrl: "https://mbo.test/v6", fetchImpl,
  });
  return { client, restore: () => {} };
}

test("three concurrent calls on a cold site issue exactly ONE token", async () => {
  const counters = { tokenIssues: 0, dataCalls: 0 };
  const { client, restore } = makeClient(counters);
  try {
    await Promise.all([
      client.get("111", "/sale/sales"),
      client.get("111", "/sale/services"),
      client.get("111", "/class/classes"),
    ]);
  } finally {
    restore();
  }
  assert.equal(counters.tokenIssues, 1, `expected 1 token issue, got ${counters.tokenIssues}`);
  assert.equal(counters.dataCalls, 3);
});

test("different sites still issue their own tokens", async () => {
  const counters = { tokenIssues: 0, dataCalls: 0 };
  const { client, restore } = makeClient(counters);
  try {
    await Promise.all([client.get("111", "/sale/services"), client.get("222", "/sale/services")]);
  } finally {
    restore();
  }
  assert.equal(counters.tokenIssues, 2);
});

test("a derived client (different pacer) SHARES the token cache — one issue across both", async () => {
  const counters = { tokenIssues: 0, dataCalls: 0 };
  const { client } = makeClient(counters);
  // A derived client with different pacing must share auth state.
  const live = client.deriveWithOptions({ requestTimeoutMs: 30_000 });
  await client.get("111", "/sale/services");
  await live.get("111", "/class/classes");
  assert.equal(counters.tokenIssues, 1, `expected shared token, got ${counters.tokenIssues} issues`);
  assert.equal(counters.dataCalls, 2);
});
