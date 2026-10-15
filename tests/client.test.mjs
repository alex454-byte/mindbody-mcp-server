import { test } from "node:test";
import assert from "node:assert/strict";
import { MboClient } from "../dist/mbo/client.js";
import { PacerBusyError } from "../dist/mbo/pacer.js";

/** Fake fetch: answers /usertoken/issue and paginated /class/classes. */
function makeFakeFetch({ pages, totalResults }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method });
    const u = new URL(url);
    if (u.pathname.endsWith("/usertoken/issue")) {
      return jsonResponse({ AccessToken: "tok", ExpiresIn: 3600 });
    }
    const offset = Number(u.searchParams.get("Offset") ?? "0");
    const limit = Number(u.searchParams.get("Limit") ?? "200");
    const pageIndex = Math.floor(offset / limit);
    const rows = pages[pageIndex] ?? [];
    return jsonResponse({
      Classes: rows,
      PaginationResponse: { PageSize: rows.length, TotalResults: totalResults },
    });
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchImpl) {
  return new MboClient({
    apiKey: "k",
    username: "u",
    password: "p",
    baseUrl: "https://api.example.test/public/v6",
    fetchImpl,
  });
}

test("getPaginated merges pages and reports complete", async () => {
  const { fetchImpl } = makeFakeFetch({
    pages: [[{ Id: 1 }, { Id: 2 }], [{ Id: 3 }]],
    totalResults: 3,
  });
  const client = makeClient(fetchImpl);
  const r = await client.getPaginated("-99", "/class/classes", {}, { limit: 2, maxPages: 10 });
  assert.equal(r.itemsKey, "Classes");
  assert.equal(r.items.length, 3);
  assert.equal(r.totalResults, 3);
  assert.equal(r.complete, true);
});

test("getPaginated stops at maxPages and flags incomplete", async () => {
  const { fetchImpl } = makeFakeFetch({
    pages: [[{ Id: 1 }], [{ Id: 2 }], [{ Id: 3 }]],
    totalResults: 3,
  });
  const client = makeClient(fetchImpl);
  const r = await client.getPaginated("-99", "/class/classes", {}, { limit: 1, maxPages: 2 });
  assert.equal(r.items.length, 2);
  assert.equal(r.complete, false);
  assert.equal(r.pagesFetched, 2);
});

test("token is cached per site — one issue for two gets", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ pages: [[{ Id: 1 }]], totalResults: 1 });
  const client = makeClient(fetchImpl);
  await client.get("-99", "/class/classes", {});
  await client.get("-99", "/class/classes", {});
  const tokenCalls = calls.filter((c) => c.url.includes("usertoken/issue"));
  assert.equal(tokenCalls.length, 1);
});

test("4xx surfaces Mindbody Error.Message but never the request", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("usertoken/issue")) {
      return jsonResponse({ AccessToken: "tok" });
    }
    return jsonResponse(
      { Error: { Message: "ContactMethod invalid", Code: "InvalidParameter" } },
      400,
    );
  };
  const client = makeClient(fetchImpl);
  await assert.rejects(
    () => client.get("-99", "/client/addcontactlog", {}),
    (err) => {
      assert.match(err.message, /ContactMethod invalid/);
      assert.doesNotMatch(err.message, /tok|Api-Key/);
      return true;
    },
  );

  let pacedAttempts = 0;
  const busyClient = new MboClient({
    apiKey: "k",
    username: "u",
    password: "p",
    baseUrl: "https://api.example.test/public/v6",
    pacer: {
      async run(_siteId, fn) {
        pacedAttempts++;
        if (pacedAttempts === 2) throw new PacerBusyError("-99", 0);
        return fn();
      },
    },
    fetchImpl: async (url) =>
      url.includes("usertoken/issue")
        ? jsonResponse({ AccessToken: "tok" })
        : jsonResponse({ Error: { Message: "should not retry a busy pacer" } }, 400),
  });
  await assert.rejects(() => busyClient.get("-99", "/client/clientcompleteinfo"), PacerBusyError);
  assert.equal(pacedAttempts, 2, "a bounded pacer rejection must not enter the retry loop");
});

test("401 triggers exactly one forced token refresh, then permanent auth error", async () => {
  let issued = 0;
  const fetchImpl = async (url) => {
    if (url.includes("usertoken/issue")) {
      issued += 1;
      return jsonResponse({ AccessToken: `tok${issued}` });
    }
    return jsonResponse({}, 401);
  };
  const client = makeClient(fetchImpl);
  await assert.rejects(
    () => client.get("-99", "/staff/staff", {}),
    /credentials rejected/,
  );
  assert.equal(issued, 2);
});
