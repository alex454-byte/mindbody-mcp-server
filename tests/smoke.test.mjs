import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * End-to-end stdio smoke test: spawn the built server with fake creds and
 * drive initialize → initialized → tools/list over newline-delimited
 * JSON-RPC. No Mindbody traffic — just the MCP handshake.
 */
function rpc(proc, message) {
  proc.stdin.write(JSON.stringify(message) + "\n");
}

async function collectResponses(proc, expectedIds, timeoutMs = 10_000) {
  const byId = new Map();
  let buffer = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout; got ids ${[...byId.keys()]}`)),
      timeoutMs,
    );
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) byId.set(msg.id, msg);
        if (expectedIds.every((id) => byId.has(id))) {
          clearTimeout(timer);
          resolve(byId);
        }
      }
    });
  });
}

async function listTools(env) {
  const proc = spawn("node", ["dist/index.js"], {
    env: {
      ...process.env,
      MBO_API_KEY: "fake",
      MBO_USERNAME: "fake",
      MBO_PASSWORD: "fake",
      MBO_SITE_ID: "-99",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    rpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    });
    const initReplies = await collectResponses(proc, [1]);
    assert.equal(initReplies.get(1).result.serverInfo.name, "mindbody-mcp-server");

    rpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    rpc(proc, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const replies = await collectResponses(proc, [2]);
    return replies.get(2).result.tools;
  } finally {
    proc.kill();
    await once(proc, "exit").catch(() => {});
  }
}

test("default server exposes 13 read-only tools", async () => {
  const tools = await listTools({});
  assert.equal(tools.length, 13);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("mbo_search_clients"));
  assert.ok(names.includes("mbo_classify_client_payment"));
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be read-only`);
  assert.ok(names.includes("mbo_api_get"));
  assert.ok(!names.includes("mbo_update_client"), "writes must be gated by default");
  assert.ok(!names.includes("mbo_create_webhook_subscription"), "webhook admin gated by default");
});

test("env gates enable write and webhook tools", async () => {
  const tools = await listTools({ MBO_ALLOW_WRITES: "true", MBO_ALLOW_WEBHOOK_ADMIN: "true" });
  const names = tools.map((t) => t.name);
  assert.equal(tools.length, 18);
  assert.ok(names.includes("mbo_add_contact_log"));
  assert.ok(names.includes("mbo_update_client"));
  assert.ok(names.includes("mbo_list_webhook_subscriptions"));
});
