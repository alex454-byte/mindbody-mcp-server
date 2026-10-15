/**
 * progressReporter(ctx): a no-op without a client progressToken; with one,
 * fire-and-forget notifications/progress sends that can never fail or delay
 * the tool.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { progressReporter, progressEnabled } from "../dist/progress.js";


/** A fake SDK ServerContext; `token: null` means "client sent no token". */
function fakeCtx({ token = "tok-1", notifyImpl } = {}) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      mcpReq: {
        _meta: token === null ? {} : { progressToken: token },
        notify:
          notifyImpl ??
          (async (n) => {
            notifications.push(n);
          }),
      },
    },
  };
}

test("progressReporter with no ctx / no token is a callable no-op that never notifies", () => {
  for (const ctx of [undefined, null, {}, { mcpReq: {} }, fakeCtx({ token: null }).ctx]) {
    const report = progressReporter(ctx, {});
    assert.equal(report.enabled, false);
    report(1, "should go nowhere", 3); // must not throw
  }
});

test("progressReporter with a token sends the exact notifications/progress shape", async () => {
  const { ctx, notifications } = fakeCtx({ token: "tok-42" });
  const report = progressReporter(ctx, {});
  assert.equal(report.enabled, true);

  report(1, "step one", 3);
  report(2, "step two"); // no total -> total omitted, not undefined
  await Promise.resolve();

  assert.deepEqual(notifications, [
    {
      method: "notifications/progress",
      params: { progressToken: "tok-42", progress: 1, total: 3, message: "step one" },
    },
    {
      method: "notifications/progress",
      params: { progressToken: "tok-42", progress: 2, message: "step two" },
    },
  ]);
});

test("progressReporter accepts a NUMERIC token (the SDK allows string | number)", async () => {
  const { ctx, notifications } = fakeCtx({ token: 7 });
  progressReporter(ctx, {})(1, "numeric token");
  await Promise.resolve();
  assert.equal(notifications[0].params.progressToken, 7);
});

test("a notify that REJECTS never throws out of report (fire-and-forget)", async () => {
  const { ctx } = fakeCtx({ notifyImpl: async () => Promise.reject(new Error("stream gone")) });
  const report = progressReporter(ctx, {});
  report(1, "doomed send");
  // Let the rejection surface if it was going to — an unhandled rejection
  // would fail this test process under node:test.
  await new Promise((r) => setTimeout(r, 5));
});

test("a notify that THROWS synchronously never throws out of report", () => {
  const { ctx } = fakeCtx({
    notifyImpl: () => {
      throw new Error("sync boom");
    },
  });
  const report = progressReporter(ctx, {});
  report(1, "doomed send");
});

test("MBO_MCP_PROGRESS gates the reporter: default ON, only explicit off-values disable", () => {
  // Default ON — it is a no-op without a client progressToken anyway.
  assert.equal(progressEnabled({}), true);
  assert.equal(progressEnabled({ MBO_MCP_PROGRESS: "1" }), true);
  assert.equal(progressEnabled({ MBO_MCP_PROGRESS: "on" }), true);
  for (const off of ["0", "false", "off", "FALSE", " Off "]) {
    assert.equal(progressEnabled({ MBO_MCP_PROGRESS: off }), false, `"${off}" must disable`);
  }

  const { ctx, notifications } = fakeCtx();
  const report = progressReporter(ctx, { MBO_MCP_PROGRESS: "0" });
  assert.equal(report.enabled, false);
  report(1, "flagged off");
  assert.equal(notifications.length, 0);
});
