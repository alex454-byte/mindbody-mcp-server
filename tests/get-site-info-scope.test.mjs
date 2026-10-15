/**
 * mbo_get_site_info must not return every site the API account can see.
 * /site/sites can return every site regardless of the SiteIds filter, so when
 * a specific site is requested the response is narrowed to that site.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../dist/tools.js";

function harness(getImpl) {
  const cbs = new Map();
  const server = { registerTool: (n, _c, cb) => cbs.set(n, cb) };
  const client = { get: getImpl };
  registerTools(server, { defaultSiteId: undefined }, client);
  return cbs.get("mbo_get_site_info");
}

const MULTI = {
  Sites: [
    { Id: -99, Name: "Sandbox Site" },
    { Id: 1001, Name: "Example Site B" },
    { Id: 1002, Name: "Example Site C" },
  ],
};
const parse = (res) => JSON.parse(res.content[0].text);

test("requesting a specific site returns only that site, never the whole roster", async () => {
  let sentParams;
  const cb = harness(async (_site, path, params) => {
    sentParams = params;
    assert.equal(path, "/site/sites");
    return MULTI;
  });
  const res = await cb({ siteId: "-99", resource: "sites" });
  const out = parse(res);
  assert.equal(out.Sites.length, 1);
  assert.equal(String(out.Sites[0].Id), "-99");
  // and the API call was scoped too
  assert.equal(sentParams.SiteIds, "-99");
});

test("a call with no siteId is rejected — a site must be named, no unscoped roster dump", async () => {
  // resolveSite requires a siteId (no default configured), so there is no path
  // that returns every site; the guard surfaces the error instead.
  const cb = harness(async () => MULTI);
  const res = await cb({ resource: "sites" });
  assert.match(res.content[0].text, /siteId/i);
});
