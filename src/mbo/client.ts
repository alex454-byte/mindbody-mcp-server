/**
 * Mindbody Public API v6 client.
 *
 * Per-site token cache, retry/backoff, 401 refresh-once semantics and a
 * pagination guard, over arbitrary v6 paths so MCP tools can cover the
 * whole API surface.
 *
 * Auth: Api-Key + SiteId headers on every request; staff user token from
 * POST /usertoken/issue sent as `Authorization: Bearer`. Tokens are cached
 * per SiteId because each site authenticates independently.
 *
 * Errors never include request headers or bodies — only method, path,
 * status, and Mindbody's structured Error.Message/Code when present.
 */
import { MboAuthError, MboError, MboRateLimitError } from "./errors.js";
import { MboPacer, PacerBusyError } from "./pacer.js";

const PAGE_SIZE = 200; // MBO's max Limit for /client/clients and /class/classes
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// Refresh tokens slightly early to avoid edge-case 401s.
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1_000;
// Safety net so a runaway upstream response (page count never reaching
// TotalResults) can't loop forever.
const HARD_MAX_PAGES = 200;

export interface MboClientOptions {
  apiKey: string;
  username: string;
  password: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Proactive outbound pacing (src/mbo/pacer.ts). Optional. */
  pacer?: MboPacer;
  /**
   * Per-FETCH timeout. Covers only the HTTP request, never the pacer wait —
   * under heavy pacing a call can sit in the pacer queue far longer than any
   * request should take. Default 30s.
   */
  requestTimeoutMs?: number;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  AccessToken?: string;
  ExpiresIn?: number;
  TokenType?: string;
}

interface SharedClientState {
  tokenCache: Map<string, TokenEntry>;
  fetchImpl: typeof fetch;
  /** Site -> in-flight token issue, so concurrent cold calls share ONE login. */
  tokenIssueInFlight: Map<string, Promise<string>>;
}

interface PaginationResponse {
  RequestedLimit?: number;
  RequestedOffset?: number;
  PageSize?: number;
  TotalResults?: number;
}

export interface PaginatedResult {
  /** Key in the MBO response the rows came from (e.g. "Classes"). */
  itemsKey: string;
  items: unknown[];
  totalResults: number | null;
  pagesFetched: number;
  /** False when maxPages stopped the fetch before TotalResults was reached. */
  complete: boolean;
}

export class MboClient {
  private readonly tokenCache: Map<string, TokenEntry>;
  private readonly tokenIssueInFlight: Map<string, Promise<string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly callerKey?: string;

  constructor(
    private readonly opts: MboClientOptions,
    callerKey?: string,
    shared?: SharedClientState,
  ) {
    if (!opts.apiKey || !opts.username || !opts.password) {
      throw new MboError("MBO credentials missing (apiKey/username/password)");
    }
    this.callerKey = callerKey;
    this.tokenCache = shared?.tokenCache ?? new Map<string, TokenEntry>();
    this.tokenIssueInFlight = shared?.tokenIssueInFlight ?? new Map<string, Promise<string>>();
    this.fetchImpl = shared?.fetchImpl ?? opts.fetchImpl ?? fetch;
  }

  /**
   * A client with option overrides (pacer, timeouts) that SHARES this client's
   * token cache + single-flight map, so two clients against the same site do
   * not each issue their own /usertoken/issue. Only AUTH state is shared.
   */
  deriveWithOptions(overrides: Partial<MboClientOptions>): MboClient {
    return new MboClient({ ...this.opts, ...overrides }, this.callerKey, {
      tokenCache: this.tokenCache,
      tokenIssueInFlight: this.tokenIssueInFlight,
      fetchImpl: overrides.fetchImpl ?? this.fetchImpl,
    });
  }

  /**
   * A view over the shared credentials and token cache that tags every request
   * with a caller identity, so the pacer can limit concurrent calls per caller.
   */
  forCaller(callerKey: string): MboClient {
    return new MboClient(this.opts, callerKey, {
      tokenCache: this.tokenCache,
      tokenIssueInFlight: this.tokenIssueInFlight,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Single authed GET against a v6 path ("/client/clientservices"). */
  async get<T = Record<string, unknown>>(
    siteId: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = withQuery(`${this.opts.baseUrl}${path}`, params ?? {});
    return this.authedJson<T>(siteId, url, { method: "GET" });
  }

  /** Authed POST with a JSON body against a v6 path. */
  async post<T = Record<string, unknown>>(
    siteId: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    return this.authedJson<T>(siteId, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Paginated GET: follows Limit/Offset until TotalResults or maxPages.
   * Rows are pulled from the response's single array field (largest array
   * when several are present; "Messages" is never treated as rows).
   */
  async getPaginated(
    siteId: string,
    path: string,
    params?: Record<string, string>,
    opts?: { maxPages?: number; limit?: number; offset?: number },
  ): Promise<PaginatedResult> {
    const limit = Math.min(opts?.limit ?? PAGE_SIZE, PAGE_SIZE);
    const maxPages = Math.min(opts?.maxPages ?? 3, HARD_MAX_PAGES);
    let offset = opts?.offset ?? 0;

    const items: unknown[] = [];
    let itemsKey = "";
    let totalResults: number | null = null;
    let pages = 0;
    let complete = false;

    while (pages < maxPages) {
      pages += 1;
      const payload = await this.get<Record<string, unknown>>(siteId, path, {
        ...params,
        Limit: String(limit),
        Offset: String(offset),
      });
      const [key, rows] = extractRows(payload);
      if (!itemsKey && key) itemsKey = key;
      items.push(...rows);

      const pagination = payload.PaginationResponse as PaginationResponse | undefined;
      if (typeof pagination?.TotalResults === "number") {
        totalResults = pagination.TotalResults;
      }
      // If PageSize is reported as 0 but rows arrived, advance by the
      // actual count to avoid an infinite loop on malformed pages.
      const pageSize = pagination?.PageSize ?? rows.length;
      const stride = pageSize > 0 ? pageSize : rows.length;
      if (stride === 0) {
        complete = true;
        break;
      }
      offset += stride;
      if (totalResults !== null && offset >= totalResults) {
        complete = true;
        break;
      }
      if (totalResults === null && rows.length < limit) {
        complete = true;
        break;
      }
    }
    return { itemsKey, items, totalResults, pagesFetched: pages, complete };
  }

  /**
   * Authed request against an absolute URL (used by the webhooks client,
   * which lives on a different host than the Public API).
   */
  async authedJson<T>(siteId: string, url: string, init: RequestInit): Promise<T> {
    let token = await this.getToken(siteId);
    let response: Response;
    try {
      response = await this.requestWithRetry(siteId, url, this.withAuth(init, siteId, token));
    } catch (err) {
      if (!(err instanceof MboAuthError)) throw err;
      // First 401 may just mean a stale cached token. Force-refresh and
      // retry once; a second 401 is a permanent credential problem.
      token = await this.getToken(siteId, true);
      try {
        response = await this.requestWithRetry(siteId, url, this.withAuth(init, siteId, token));
      } catch (retryErr) {
        if (retryErr instanceof MboAuthError) {
          this.tokenCache.delete(siteId);
          throw new MboAuthError(
            `Mindbody credentials rejected for site ${siteId} after token refresh — verify Api-Key, username, password, and SiteId (staff must have API access at this site).`,
          );
        }
        throw retryErr;
      }
    }
    return (await response.json()) as T;
  }

  // ----------------------------------------------------------------
  // Auth
  // ----------------------------------------------------------------
  private async getToken(siteId: string, forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = this.tokenCache.get(siteId);
      if (cached && cached.expiresAt > Date.now()) return cached.token;
    }
    // Single-flight: concurrent cold calls must share ONE /usertoken/issue,
    // not each perform their own login. A forced refresh joins an in-flight
    // issue too: that token is brand new by definition.
    const inFlight = this.tokenIssueInFlight.get(siteId);
    if (inFlight) return inFlight;
    const issue = this.issueToken(siteId);
    this.tokenIssueInFlight.set(siteId, issue);
    try {
      return await issue;
    } finally {
      this.tokenIssueInFlight.delete(siteId);
    }
  }

  private async issueToken(siteId: string): Promise<string> {
    const url = `${this.opts.baseUrl}/usertoken/issue`;
    const response = await this.requestWithRetry(siteId, url, {
      method: "POST",
      headers: {
        "Api-Key": this.opts.apiKey,
        SiteId: siteId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Username: this.opts.username,
        Password: this.opts.password,
      }),
    });
    const data = (await response.json()) as TokenResponse;
    if (!data.AccessToken) {
      throw new MboAuthError(`No AccessToken in /usertoken/issue response for site ${siteId}`);
    }
    // ExpiresIn isn't in the documented response but some payloads return seconds.
    const expiresInMs = data.ExpiresIn ? data.ExpiresIn * 1_000 : 6 * 60 * 60 * 1_000;
    this.tokenCache.set(siteId, {
      token: data.AccessToken,
      expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_BUFFER_MS,
    });
    return data.AccessToken;
  }

  private withAuth(init: RequestInit, siteId: string, token: string): RequestInit {
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        "Api-Key": this.opts.apiKey,
        SiteId: siteId,
        Authorization: `Bearer ${token}`,
      },
    };
  }

  // ----------------------------------------------------------------
  // HTTP with retry/backoff
  // ----------------------------------------------------------------
  private async requestWithRetry(
    siteId: string,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        // The per-fetch timeout lives INSIDE fetchWithPacing, so it starts
        // only after the pacer grants a slot — never during the queue wait.
        response = await this.fetchWithPacing(siteId, url, init);
      } catch (err) {
        // The pacer already waited its bounded maximum. Retrying it as if it
        // were a transient socket failure would multiply that wait and turn a
        // clear "busy" result back into a client timeout.
        if (err instanceof PacerBusyError) throw err;
        if (attempt < MAX_RETRIES) {
          await sleepBackoff(attempt);
          continue;
        }
        throw new MboError(
          `MBO request failed after ${MAX_RETRIES + 1} attempts: ${(err as Error).message}`,
        );
      }

      if (response.status < 400) return response;
      if (response.status === 401) {
        throw new MboAuthError(`401 from ${urlPath(url)} (site ${siteId})`);
      }
      if (response.status === 429) {
        if (attempt < MAX_RETRIES) {
          await sleepBackoff(attempt, response.headers.get("Retry-After"));
          continue;
        }
        // The pacer schedules every HTTP attempt, but only applies the
        // cross-request pause after this request's own retries are exhausted.
        // That preserves the client's established retry policy while making
        // the NEXT request stand down for this site.
        this.opts.pacer?.noteRateLimit(siteId);
        throw new MboRateLimitError(
          `429 from ${urlPath(url)} after ${MAX_RETRIES + 1} attempts — Mindbody is rate limiting this site`,
        );
      }
      if (response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleepBackoff(attempt);
          continue;
        }
        throw new MboError(`${response.status} from ${urlPath(url)}`, response.status);
      }
      // Other 4xx: surface Mindbody's structured error fields only (never
      // the raw body — it can echo request contents).
      throw new MboError(
        `Mindbody returned ${response.status} from ${urlPath(url)}${await upstreamDetail(response)}`,
        response.status,
      );
    }
    throw new MboError("unreachable retry exit");
  }

  /** Prune the pacer's per-site state (called opportunistically). */
  prunePacer(): void {
    this.opts.pacer?.prune();
  }

  /** Every actual fetch, including token issue and retry attempts, is paced. */
  private fetchWithPacing(siteId: string, url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    // The timer is created HERE, inside send, so the clock starts when the
    // fetch actually begins — after the pacer has granted a slot. Starting it
    // before the pacer wait would abort heavily-paced calls that are merely
    // queued, not slow. The pacer bounds the queue wait itself.
    const send = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    if (!this.opts.pacer) return send();
    return this.opts.pacer.run(siteId, send, {
      callerKey: this.callerKey,
      // A 429 is a Response rather than an exception until retries are
      // exhausted below. It must not falsely reset an existing pause.
      isSuccessfulResult: (result) => !(result instanceof Response) || result.status !== 429,
    });
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function extractRows(payload: Record<string, unknown>): [string, unknown[]] {
  let bestKey = "";
  let bestRows: unknown[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "Messages") continue;
    if (Array.isArray(value) && value.length >= bestRows.length) {
      if (bestKey === "" || value.length > bestRows.length) {
        bestKey = key;
        bestRows = value;
      }
    }
  }
  return [bestKey, bestRows];
}

async function upstreamDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      Error?: { Message?: string; Code?: string };
    };
    const message = body?.Error?.Message;
    const code = body?.Error?.Code;
    if (message || code) {
      return `: ${[code, message].filter(Boolean).join(" — ").slice(0, 300)}`;
    }
  } catch {
    // Non-JSON body: deliberately dropped.
  }
  return "";
}

function withQuery(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.searchParams.set(k, v);
  }
  return u.toString();
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function sleepBackoff(attempt: number, retryAfter?: string | null): Promise<void> {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      // Honor Retry-After with ±20% jitter so concurrent callers at the
      // same site don't retry in lockstep.
      const baseMs = Math.min(seconds * 1_000, MAX_BACKOFF_MS);
      const jitter = (Math.random() - 0.5) * baseMs * 0.4;
      await sleep(Math.max(0, baseMs + jitter));
      return;
    }
  }
  const exp = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  await sleep(exp + Math.random() * exp * 0.1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
