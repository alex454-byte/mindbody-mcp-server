/**
 * MCP progress notifications for long tool calls.
 *
 * Wire shape (@modelcontextprotocol/server 2.x): the tool callback's second
 * argument is a request context whose `mcpReq._meta?.progressToken`
 * (string | number) is set only when the CLIENT asked for progress, and
 * `mcpReq.notify(...)` sends a `notifications/progress` with
 * `{progressToken, progress, total?, message?}`.
 *
 * Flag: MBO_MCP_PROGRESS — default ON, because without a client progressToken
 * the reporter is a no-op anyway; set to 0/false/off to force it off.
 *
 * Rules: notifications are FIRE-AND-FORGET (a notify failure must never fail
 * or delay a tool), and messages carry NO PII — counts only.
 */

/** progress + optional total + human message; never throws, never awaited. */
export interface ProgressReporter {
  (progress: number, message: string, total?: number): void;
  /** False for the no-op — lets callers skip building progress plumbing. */
  readonly enabled: boolean;
}

interface CtxLike {
  mcpReq?: {
    _meta?: { progressToken?: string | number };
    notify?: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void>;
  };
}

/** MBO_MCP_PROGRESS gate — default ON; only an explicit off-value disables. */
export function progressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MBO_MCP_PROGRESS ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/** The client's progressToken, if the ctx carries one (undefined otherwise). */
export function progressTokenOf(ctx: unknown): string | number | undefined {
  const token = (ctx as CtxLike | undefined)?.mcpReq?._meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

const noop = (() => {}) as (progress: number, message: string, total?: number) => void;
const NO_PROGRESS: ProgressReporter = Object.assign(noop, { enabled: false as const });

/**
 * A reporter bound to this call's ctx: a NO-OP unless the flag is on AND the
 * client sent a progressToken AND the ctx can notify. Each report is a
 * fire-and-forget notifications/progress send; a notify that throws or
 * rejects is swallowed — progress must never affect the tool's result.
 */
export function progressReporter(ctx: unknown, env: NodeJS.ProcessEnv = process.env): ProgressReporter {
  if (!progressEnabled(env)) return NO_PROGRESS;
  const token = progressTokenOf(ctx);
  const notify = (ctx as CtxLike | undefined)?.mcpReq?.notify;
  if (token === undefined || typeof notify !== "function") return NO_PROGRESS;
  const report = (progress: number, message: string, total?: number): void => {
    try {
      void notify({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined ? { total } : {}),
          message,
        },
      }).catch(() => {
        /* fire-and-forget: a failed send never touches the tool call */
      });
    } catch {
      /* a synchronously-throwing notify never touches the tool call either */
    }
  };
  return Object.assign(report, { enabled: true as const });
}
