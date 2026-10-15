/**
 * Per-site /sale/services catalog cache: 12h memo, single-flight for
 * concurrent callers, bounded stale-on-failure, and never caching an
 * incomplete page. Driven with an injected clock.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchServiceCatalog,
  invalidateCatalog,
  clearCatalogCache,
  CATALOG_TTL_MS,
  CATALOG_MAX_STALE_MS,
} from "../dist/mbo/catalog-cache.js";

// The module memo is process-global by design; every test starts cold.
beforeEach(() => clearCatalogCache());

// ---- unit tests: the cache itself ----

/** A catalog-only client that records every underlying MBO call. */
function countingClient(respond) {
  const calls = [];
  return {
    calls,
    async getPaginated(siteId, path, params, opts) {
      calls.push({ siteId, path, params, opts });
      return respond(siteId, calls.length);
    },
  };
}

test("TTL memo: a second fetch within 12h makes ZERO MBO calls and returns the same catalog", async () => {
  const client = countingClient(() => ({ items: [{ Name: "Unlimited Monthly" }], complete: true }));
  let t = 0;
  const now = () => t;
  const first = await fetchServiceCatalog(client, "111", { now });
  t += CATALOG_TTL_MS - 1;
  const second = await fetchServiceCatalog(client, "111", { now });
  assert.equal(client.calls.length, 1, "the catalog must be fetched exactly once inside the TTL");
  assert.deepEqual(first.items, [{ Name: "Unlimited Monthly" }]);
  assert.equal(first.complete, true);
  assert.deepEqual(second, first);
});

test("the underlying fetch is GET /sale/services with a 2-page cap", async () => {
  const client = countingClient(() => ({ items: [], complete: true }));
  await fetchServiceCatalog(client, "42");
  assert.deepEqual(client.calls, [
    { siteId: "42", path: "/sale/services", params: {}, opts: { maxPages: 2 } },
  ]);
});

test("TTL expiry: a fetch past 12h refreshes from MBO", async () => {
  const client = countingClient((_site, n) => ({ items: [{ v: n }], complete: true }));
  let t = 0;
  const now = () => t;
  await fetchServiceCatalog(client, "111", { now });
  t = CATALOG_TTL_MS + 1;
  const r = await fetchServiceCatalog(client, "111", { now });
  assert.equal(client.calls.length, 2);
  assert.deepEqual(r.items, [{ v: 2 }], "the refreshed catalog is served, not the stale one");
});

test("single-flight: 3 concurrent callers for one site share ONE fetch", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let fetches = 0;
  const client = {
    async getPaginated() {
      fetches += 1;
      await gate;
      return { items: [{ Name: "Shared" }], complete: true };
    },
  };
  const inFlight = [
    fetchServiceCatalog(client, "111"),
    fetchServiceCatalog(client, "111"),
    fetchServiceCatalog(client, "111"),
  ];
  release();
  const results = await Promise.all(inFlight);
  assert.equal(fetches, 1, "concurrent callers must join the one in-flight fetch");
  for (const r of results) assert.deepEqual(r.items, [{ Name: "Shared" }]);
  // The flight map was cleared: an invalidated site fetches fresh, not a dead promise.
  invalidateCatalog("111");
  await fetchServiceCatalog(client, "111");
  assert.equal(fetches, 2);
});

test("per-site isolation: each site gets its own catalog and its own TTL entry", async () => {
  const client = countingClient((siteId) => ({ items: [{ site: siteId }], complete: true }));
  const a = await fetchServiceCatalog(client, "111");
  const b = await fetchServiceCatalog(client, "222");
  assert.deepEqual(a.items, [{ site: "111" }]);
  assert.deepEqual(b.items, [{ site: "222" }]);
  assert.equal(client.calls.length, 2);
  await fetchServiceCatalog(client, "111");
  await fetchServiceCatalog(client, "222");
  assert.equal(client.calls.length, 2, "both sites are served from their own memo");
});

test("stale-on-failure: within 24h of the last success a failed refresh serves the stale catalog; beyond it the outage surfaces; recovery re-caches", async () => {
  let t = 0;
  let fail = false;
  const now = () => t;
  const client = countingClient(() => {
    if (fail) throw new Error("MBO down");
    return { items: [{ Name: "v1" }], complete: true };
  });
  await fetchServiceCatalog(client, "111", { now });

  // Expired but within the 24h stale bound: the refresh fails, the stale copy answers.
  fail = true;
  t = CATALOG_TTL_MS + 1;
  const stale = await fetchServiceCatalog(client, "111", { now });
  assert.deepEqual(stale.items, [{ Name: "v1" }]);
  assert.equal(client.calls.length, 2, "a refresh was attempted before falling back to stale");

  // Beyond the bound the outage must surface, naming the last success (A19 pattern).
  t = CATALOG_MAX_STALE_MS + 1;
  await assert.rejects(
    () => fetchServiceCatalog(client, "111", { now }),
    (err) => /over 24h/.test(err.message) && /1970-01-01T00:00:00.000Z/.test(err.message) && /MBO down/.test(err.message),
  );

  // MBO recovers: the next call fetches and re-caches.
  fail = false;
  const recovered = await fetchServiceCatalog(client, "111", { now });
  assert.deepEqual(recovered.items, [{ Name: "v1" }]);
  const after = client.calls.length;
  await fetchServiceCatalog(client, "111", { now });
  assert.equal(client.calls.length, after, "recovery re-populated the memo");
});

test("a fetch failure with NO prior success rethrows the error untouched", async () => {
  const client = countingClient(() => {
    throw new Error("MBO down");
  });
  await assert.rejects(() => fetchServiceCatalog(client, "111"), /MBO down/);
});

test("incomplete never cached: a page-capped catalog passes through UNCACHED so complete:false is reported every call", async () => {
  let complete = false;
  const client = countingClient(() => ({ items: [{ Name: "Partial" }], complete }));
  const r1 = await fetchServiceCatalog(client, "111");
  assert.equal(r1.complete, false, "the incomplete flag must reach the caller");
  assert.deepEqual(r1.items, [{ Name: "Partial" }]);
  const r2 = await fetchServiceCatalog(client, "111");
  assert.equal(r2.complete, false);
  assert.equal(client.calls.length, 2, "an incomplete result must NOT be memoized");
  complete = true;
  await fetchServiceCatalog(client, "111");
  await fetchServiceCatalog(client, "111");
  assert.equal(client.calls.length, 3, "the first complete result is memoized");
});

test("invalidateCatalog forces a refetch for that site only", async () => {
  const client = countingClient((siteId) => ({ items: [{ site: siteId }], complete: true }));
  await fetchServiceCatalog(client, "111");
  await fetchServiceCatalog(client, "222");
  invalidateCatalog("111");
  await fetchServiceCatalog(client, "111");
  await fetchServiceCatalog(client, "222");
  assert.equal(client.calls.length, 3, "111 refetched once; 222 still served from its memo");
  assert.deepEqual(client.calls.map((c) => c.siteId), ["111", "222", "111"]);
});

