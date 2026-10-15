/**
 * End-to-end through registerTools: every tool result is masked before it is
 * returned, and member tokens the model passes back are resolved to real ids
 * only on the outbound Mindbody call. All data is synthetic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../dist/tools.js";
import { setPseudonymPepper } from "../dist/pii.js";

setPseudonymPepper("tools-test-pepper-0000000000000000000000000000");

const CLIENT_RECORD = {
  Id: "100000001",
  FirstName: "Test",
  LastName: "Member",
  Email: "test.member@example.com",
  MobilePhone: "555-0100",
  RedAlert: "synthetic sensitive note",
  Status: "Active",
};

function harness(cfg = {}) {
  const tools = new Map();
  const calls = [];
  const server = { registerTool: (name, _config, cb) => tools.set(name, cb) };
  const client = {
    async get(siteId, path, params) {
      calls.push({ siteId, path, params });
      if (path === "/client/clientvisits") return { Visits: [{ ClientId: params.ClientId, ClassId: 7 }] };
      if (path === "/class/classvisits") return { Class: { Id: Number(params.ClassId), Visits: [] } };
      return {};
    },
    async getPaginated(siteId, path, params) {
      calls.push({ siteId, path, params });
      if (path === "/client/clients") return { itemsKey: "Clients", items: [CLIENT_RECORD], complete: true };
      if (path === "/client/clientvisits") {
        return { itemsKey: "Visits", items: [{ ClientId: params.ClientId, ClassId: 7 }], complete: true };
      }
      return { items: [], complete: true };
    },
  };
  const { toolCount } = registerTools(server, { defaultSiteId: "-99", ...cfg }, client);
  return { tools, calls, toolCount };
}

const parse = (res) => JSON.parse(res.content[0].text);

test("a member search returns no contact details, no real id and no full name", async () => {
  const { tools } = harness();
  const res = await tools.get("mbo_search_clients")({ searchText: "Test" });
  const text = res.content[0].text;
  for (const leak of ["test.member@example.com", "555-0100", "100000001", "Member", "synthetic sensitive note"]) {
    assert.ok(!text.includes(leak), `leaked ${leak}: ${text}`);
  }
  const [member] = parse(res).items;
  assert.match(member.Id, /^m_[0-9a-f]{16}$/);
  assert.equal(member.FirstName, "T");
  assert.equal(member.Status, "Active");
  assert.ok(member._withheld.includes("RedAlert"));
});

test("a token from one result can be passed back; the real id goes only to Mindbody", async () => {
  const { tools, calls } = harness();
  const token = parse(await tools.get("mbo_search_clients")({ searchText: "Test" })).items[0].Id;

  const res = await tools.get("mbo_get_client_visits")({ clientId: token });
  const outbound = calls.find((c) => c.path === "/client/clientvisits");
  assert.equal(outbound.params.ClientId, "100000001", "the API call must use the real id");
  assert.ok(!res.content[0].text.includes("100000001"), "the result must not echo the real id");
  assert.equal(parse(res).items[0].ClientId, token, "the same member maps to the same token");
});

test("raw GET params resolve tokens too, including comma-separated lists", async () => {
  const { tools, calls } = harness();
  const token = parse(await tools.get("mbo_search_clients")({ searchText: "Test" })).items[0].Id;
  await tools.get("mbo_api_get")({ path: "/client/clientvisits", params: { ClientIds: `${token},42` } });
  const outbound = calls.find((c) => c.path === "/client/clientvisits");
  assert.equal(outbound.params.ClientIds, "100000001,42");
});

test("an unknown token is refused rather than sent to Mindbody", async () => {
  const { tools, calls } = harness();
  const res = await tools.get("mbo_get_client")({ clientId: "m_0000000000000000" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown member token/);
  assert.equal(calls.length, 0);
});

test("contact logs are not exposed — free text cannot be masked reliably", () => {
  const { tools } = harness({ allowWrites: true, allowWebhookAdmin: true });
  assert.equal(tools.has("mbo_get_contact_logs"), false);
});

test("write and webhook tools register only behind their flags", () => {
  assert.equal(harness().toolCount, 13);
  assert.equal(harness({ allowWrites: true }).toolCount, 15);
  assert.equal(harness({ allowWebhookAdmin: true }).toolCount, 16);
});

test("session rosters report progress when the client sent a progress token", async () => {
  const { tools } = harness();
  const sent = [];
  const ctx = { mcpReq: { _meta: { progressToken: "p1" }, notify: async (n) => sent.push(n) } };
  await tools.get("mbo_get_class_visits")({ classIds: [1, 2, 3] }, ctx);
  await Promise.resolve();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.at(-1).params, {
    progressToken: "p1",
    progress: 3,
    total: 3,
    message: "Fetched session rosters (3/3)",
  });
});
