/**
 * Configuration from environment variables.
 */

export interface MboMcpConfig {
  apiKey: string;
  username: string;
  password: string;
  /** Default SiteId when a tool call doesn't pass one. Sandbox is "-99". */
  defaultSiteId?: string;
  apiBaseUrl: string;
  webhooksBaseUrl: string;
  /** Registers write tools (update client, add contact log). Default off. */
  allowWrites: boolean;
  /** Registers webhook subscription admin tools. Default off. */
  allowWebhookAdmin: boolean;
}

const DEFAULT_API_BASE = "https://api.mindbodyonline.com/public/v6";
const DEFAULT_WEBHOOKS_BASE = "https://mindbody.io/platform/webhooks/v1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MboMcpConfig {
  const apiKey = env.MBO_API_KEY ?? "";
  const username = env.MBO_USERNAME ?? "";
  const password = env.MBO_PASSWORD ?? "";

  const missing: string[] = [];
  if (!apiKey) missing.push("MBO_API_KEY");
  if (!username) missing.push("MBO_USERNAME");
  if (!password) missing.push("MBO_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `Missing Mindbody credentials: ${missing.join(", ")}. ` +
        `For the public sandbox use SiteId -99 with the sandbox staff login from the ` +
        `Mindbody developer docs and an API key from https://developers.mindbodyonline.com.`,
    );
  }

  return {
    apiKey: apiKey.trim(),
    username: username.trim(),
    password,
    defaultSiteId: env.MBO_SITE_ID || undefined,
    apiBaseUrl: (env.MBO_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, ""),
    webhooksBaseUrl: (env.MBO_WEBHOOKS_BASE ?? DEFAULT_WEBHOOKS_BASE).replace(/\/$/, ""),
    allowWrites: isTruthy(env.MBO_ALLOW_WRITES),
    allowWebhookAdmin: isTruthy(env.MBO_ALLOW_WEBHOOK_ADMIN),
  };
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}
