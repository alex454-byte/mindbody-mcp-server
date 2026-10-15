/**
 * Proactive outbound pacing to Mindbody, plus a global concurrency ceiling.
 *
 * src/mbo/client.ts does the REACTIVE half — retry with exponential backoff,
 * jitter, `Retry-After`, 401-refresh-once, per-request timeouts. This file is
 * the PROACTIVE half: not hitting the limit in the first place.
 *
 * Mindbody's limits apply per account and site, and the vendor does not
 * publish a per-second figure, so the gaps below are conservative headroom
 * choices, not documented limits. Tune them with PacerOptions.
 *
 *   - a minimum gap between calls to the SAME site (different sites do not
 *     wait on each other);
 *   - graduated pacing: once one site has absorbed a burst of calls inside a
 *     window, its gap widens until it goes quiet again;
 *   - a smart pause after a 429 that survived the client's own retries;
 *   - a BOUNDED wait, so a caller gets a clear "busy" error instead of a hang;
 *   - a GLOBAL concurrency cap, and an optional per-caller concurrency cap.
 */

/** Minimum gap between two calls to one site. */
const DEFAULT_MIN_GAP_MS = 600;
/**
 * GRADUATED PACING. Light, interactive use of one site stays fast at the
 * normal gap. Once a site has absorbed `SUSTAINED_AFTER_CALLS` inside
 * `SUSTAINED_WINDOW_MS`, the gap widens to `SUSTAINED_GAP_MS` for that site.
 * 20 calls a minute against one site is past interactive use — that is a
 * script or a runaway loop, which is exactly what should be slowed. Slowing
 * down degrades gracefully; a hard refusal would look broken.
 */
const SUSTAINED_AFTER_CALLS = 20;
const SUSTAINED_WINDOW_MS = 60_000;
const SUSTAINED_GAP_MS = 5_000;
/**
 * SMART PAUSE. The client retries an INDIVIDUAL request on 429 but knows
 * nothing about the next request. A 429 that survives those retries means the
 * site is genuinely over its limit, so hold off on it entirely for a while.
 * Escalates while pushback continues, resets on success.
 */
const DEFAULT_BASE_PAUSE_MS = 5_000;
const DEFAULT_MAX_PAUSE_MS = 30_000;
/** Concurrent calls allowed per caller identity (when a caller key is given). */
const DEFAULT_MAX_CONCURRENT_PER_CALLER = 1;
/** Never queue longer than this; fail with a clear busy error instead. */
const DEFAULT_MAX_WAIT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 6;
/** How often a queued caller re-checks for a free slot. */
const POLL_MS = 50;

export type BusyReason = "paced" | "rate-limited";

export class PacerBusyError extends Error {
  constructor(siteId: string, waitedMs: number, reason: BusyReason = "paced") {
    const why =
      reason === "rate-limited"
        ? `Mindbody rate limited site ${siteId}, so this server is backing off and ` +
          `is paused for that site to let it recover.`
        : `Mindbody is busy for site ${siteId} — this server paces requests to stay ` +
          `inside Mindbody's per-site limit.`;
    super(`${why} Gave up after ${Math.round(waitedMs / 1000)}s rather than hang. Try again shortly.`);
    this.name = "PacerBusyError";
  }
}

/** Options for a single paced call. */
export interface RunOptions {
  /**
   * Stable per-user identity, NOT a per-connection id —
   * the whole point is to recognise the same person across two sessions.
   */
  callerKey?: string;
  /** A non-successful HTTP response must not clear an existing 429 pause. */
  isSuccessfulResult?: (result: unknown) => boolean;
}

/**
 * Did Mindbody itself push back, as opposed to the request being wrong?
 * Only real pushback should pause a site: pausing on a 404 would let one bad
 * query stall that site for everybody.
 */
function isPushback(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; statusCode?: unknown; status?: unknown };
  return e.name === "MboRateLimitError" || e.statusCode === 429 || e.status === 429;
}

export interface PacerOptions {
  minGapMs?: number;
  /**
   * Calls to ONE site inside the sustained window that skip the min gap
   * entirely — a
   * short interactive question runs unthrottled, then pacing resumes. 0 (the
   * default) disables the burst; the sustained escalation is unaffected.
   */
  burstCalls?: number;
  /** Calls to ONE site within the window before the wide gap kicks in. */
  sustainedAfterCalls?: number;
  sustainedWindowMs?: number;
  /** The wide gap applied once a site is being hammered. */
  sustainedGapMs?: number;
  maxWaitMs?: number;
  maxConcurrent?: number;
  /** Concurrent MBO calls allowed per caller identity. */
  maxConcurrentPerCaller?: number;
  /** Pause applied to a site after Mindbody pushes back. */
  basePauseMs?: number;
  /** Ceiling on the escalated pause. */
  maxPauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class MboPacer {
  private readonly lastCallAt = new Map<string, number>();
  /** Recent call timestamps per site, trimmed to the sustained window. */
  private readonly recentCalls = new Map<string, number[]>();
  private readonly minGapMs: number;
  private readonly burstCalls: number;
  private readonly sustainedAfterCalls: number;
  private readonly sustainedWindowMs: number;
  private readonly sustainedGapMs: number;
  /** Site -> timestamp until which we send it nothing. */
  private readonly pausedUntil = new Map<string, number>();
  /** Site -> consecutive pushbacks, which drive the escalation. */
  private readonly pushbacks = new Map<string, number>();
  /** Caller -> calls currently in flight for that human. */
  private readonly inFlightByCaller = new Map<string, number>();
  private readonly maxWaitMs: number;
  private readonly maxConcurrent: number;
  private readonly maxConcurrentPerCaller: number;
  private readonly basePauseMs: number;
  private readonly maxPauseMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private inFlight = 0;

  constructor(opts: PacerOptions = {}) {
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.burstCalls = opts.burstCalls ?? 0;
    this.sustainedAfterCalls = opts.sustainedAfterCalls ?? SUSTAINED_AFTER_CALLS;
    this.sustainedWindowMs = opts.sustainedWindowMs ?? SUSTAINED_WINDOW_MS;
    this.sustainedGapMs = opts.sustainedGapMs ?? SUSTAINED_GAP_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxConcurrentPerCaller = opts.maxConcurrentPerCaller ?? DEFAULT_MAX_CONCURRENT_PER_CALLER;
    this.basePauseMs = opts.basePauseMs ?? DEFAULT_BASE_PAUSE_MS;
    this.maxPauseMs = opts.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Run `fn` under the per-site gap and the global concurrency cap.
   *
   * The slot is reserved BEFORE awaiting `fn` and released in a `finally`, so
   * a throwing call cannot leak a concurrency slot — that failure mode is
   * silent and only shows up later as unexplained "busy" errors.
   */
  async run<T>(siteId: string, fn: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const startedWaiting = this.now();
    const callerKey = opts.callerKey;

    // Caller slot FIRST, before the global slot: a request queued behind the
    // same person must not sit on a scarce global slot while it waits.
    if (callerKey !== undefined) {
      while ((this.inFlightByCaller.get(callerKey) ?? 0) >= this.maxConcurrentPerCaller) {
        if (this.now() - startedWaiting >= this.maxWaitMs) {
          throw new PacerBusyError(siteId, this.now() - startedWaiting);
        }
        await this.sleep(POLL_MS);
      }
      this.inFlightByCaller.set(callerKey, (this.inFlightByCaller.get(callerKey) ?? 0) + 1);
    }

    try {
      // Wait for a global concurrency slot.
      while (this.inFlight >= this.maxConcurrent) {
        if (this.now() - startedWaiting >= this.maxWaitMs) {
          throw new PacerBusyError(siteId, this.now() - startedWaiting);
        }
        await this.sleep(POLL_MS);
      }

      // Wait out whichever is longer: the per-site gap, or a pause this site
      // is serving after real pushback. Recomputed each loop because another
      // request for the same site may have gone ahead while this one waited,
      // and because the required gap itself widens under sustained load.
      for (;;) {
        const pauseLeft = this.pauseRemainingMs(siteId);
        const last = this.lastCallAt.get(siteId);
        const gapLeft = last === undefined ? 0 : last + this.gapFor(siteId) - this.now();
        const waitNeeded = Math.max(pauseLeft, gapLeft);
        if (waitNeeded <= 0) break;
        if (this.now() - startedWaiting + waitNeeded > this.maxWaitMs) {
          throw new PacerBusyError(
            siteId,
            this.now() - startedWaiting,
            pauseLeft > gapLeft ? "rate-limited" : "paced",
          );
        }
        await this.sleep(waitNeeded);
      }

      // Stamp BEFORE the call, not after. Stamping after would let N concurrent
      // callers for one site all observe "no recent call" and fire together —
      // the exact burst this exists to prevent.
      this.lastCallAt.set(siteId, this.now());
      this.recordCall(siteId);
      this.inFlight++;
      try {
        const result = await fn();
        // A clean response means the site is healthy again; drop any
        // escalation so the next blip starts from the base pause rather than
        // inheriting an old streak. MboClient marks a 429 Response as
        // non-success here because it needs to finish its own retries first.
        if (opts.isSuccessfulResult?.(result) ?? true) {
          this.pushbacks.delete(siteId);
          this.pausedUntil.delete(siteId);
        }
        return result;
      } catch (err) {
        // Record the pause, then RE-THROW — the caller still needs the error.
        if (isPushback(err)) this.notePushback(siteId);
        throw err;
      } finally {
        this.inFlight--;
      }
    } finally {
      if (callerKey !== undefined) {
        const left = (this.inFlightByCaller.get(callerKey) ?? 1) - 1;
        if (left > 0) this.inFlightByCaller.set(callerKey, left);
        else this.inFlightByCaller.delete(callerKey);
      }
    }
  }

  /** Milliseconds this site is still paused for; 0 when it is not paused. */
  pauseRemainingMs(siteId: string): number {
    const until = this.pausedUntil.get(siteId);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.pausedUntil.delete(siteId);
    return 0;
  }

  /** Record a 429 that exhausted MboClient's own retry policy. */
  noteRateLimit(siteId: string): void {
    this.notePushback(siteId);
  }

  /** Escalate this site's pause: 5s, 10s, 20s, capped at maxPauseMs. */
  private notePushback(siteId: string): void {
    const streak = (this.pushbacks.get(siteId) ?? 0) + 1;
    this.pushbacks.set(siteId, streak);
    const pause = Math.min(this.maxPauseMs, this.basePauseMs * 2 ** (streak - 1));
    this.pausedUntil.set(siteId, this.now() + pause);
  }

  /**
   * The gap this site currently owes: nothing while inside the burst
   * allowance, the normal gap after it, or the wide sustained gap once the
   * site is being hit hard inside the window.
   */
  gapFor(siteId: string): number {
    const recent = this.recentCallCount(siteId);
    if (recent >= this.sustainedAfterCalls) return this.sustainedGapMs;
    if (recent < this.burstCalls) return 0;
    return this.minGapMs;
  }

  private recentCallCount(siteId: string): number {
    const cutoff = this.now() - this.sustainedWindowMs;
    const calls = (this.recentCalls.get(siteId) ?? []).filter((t) => t > cutoff);
    if (calls.length > 0) this.recentCalls.set(siteId, calls);
    else this.recentCalls.delete(siteId);
    return calls.length;
  }

  private recordCall(siteId: string): void {
    const cutoff = this.now() - this.sustainedWindowMs;
    const calls = (this.recentCalls.get(siteId) ?? []).filter((t) => t > cutoff);
    calls.push(this.now());
    this.recentCalls.set(siteId, calls);
  }

  stats(): { inFlight: number; trackedSites: number } {
    return { inFlight: this.inFlight, trackedSites: this.lastCallAt.size };
  }

  /** Drop sites whose gap has long since elapsed — they hold no useful state. */
  prune(): void {
    const cutoff = this.now() - this.minGapMs * 10;
    for (const [siteId, at] of this.lastCallAt) {
      if (at < cutoff) this.lastCallAt.delete(siteId);
    }
    // Recent-call history expires on its own window, independently of the
    // gap bookkeeping above.
    const windowCutoff = this.now() - this.sustainedWindowMs;
    for (const [siteId, calls] of this.recentCalls) {
      const live = calls.filter((t) => t > windowCutoff);
      if (live.length > 0) this.recentCalls.set(siteId, live);
      else this.recentCalls.delete(siteId);
    }
    // Expired pauses (and the streak behind them) hold no useful state.
    for (const [siteId, until] of this.pausedUntil) {
      if (until <= this.now()) {
        this.pausedUntil.delete(siteId);
        this.pushbacks.delete(siteId);
      }
    }
  }
}
