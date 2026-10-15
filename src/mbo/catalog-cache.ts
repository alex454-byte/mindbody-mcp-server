/**
 * Per-site /sale/services catalog cache.
 *
 * A site's service catalog — its price list — changes rarely, so it is
 * memoized in-process per site instead of fetched on every call.
 *
 * Behavior:
 *  - TTL 12h.
 *  - SINGLE-FLIGHT: concurrent callers for one site join the one in-flight
 *    fetch (in-flight promise map, cleared when the fetch settles).
 *  - STALE-ON-FAILURE, BOUNDED: a failed refresh serves the previous catalog
 *    for up to 24h past its last success; beyond that the outage surfaces — an
 *    unbounded stale price list would keep quoting retired offers.
 *  - NEVER caches an incomplete page: a page-capped catalog passes through
 *    UNCACHED, so `complete: false` is reported on every call, not once per TTL.
 */

interface PaginatedLike {
  items?: unknown[];
  complete?: boolean;
}

/** The one client method the cache needs. */
export interface CatalogFetcher {
  getPaginated(
    siteId: string,
    path: string,
    params?: Record<string, string>,
    opts?: { maxPages?: number },
  ): Promise<PaginatedLike>;
}

/** The catalog page. */
export interface ServiceCatalogPage {
  items: unknown[];
  /** false when the page cap was hit before all rows returned. */
  complete: boolean;
}

/** Catalogs change rarely (price-list edits are occasional, deliberate acts). */
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a stale catalog may keep serving through a Mindbody outage. */
export const CATALOG_MAX_STALE_MS = 24 * 60 * 60 * 1000;
/** Page cap for the catalog fetch (200 rows/page). */
const CATALOG_MAX_PAGES = 2;

export interface CatalogCacheDeps {
  /** Injectable clock (ms) so TTL/stale behavior is deterministic in tests. */
  now?: () => number;
}

interface CacheEntry {
  page: ServiceCatalogPage;
  expiresAt: number;
  /** When the data was actually fetched — drives the max-stale bound. */
  fetchedAt: number;
}

/**
 * In-process memo, keyed by site. An expired entry is deliberately KEPT rather
 * than deleted: if the refresh fails, yesterday's price list is far better
 * than a hard error in the middle of answering a question — up to the bound.
 */
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ServiceCatalogPage>>();

/** The site's /sale/services page, memoized 12h, single-flight, bounded stale-on-failure. */
export async function fetchServiceCatalog(
  client: CatalogFetcher,
  siteId: string,
  deps: CatalogCacheDeps = {},
): Promise<ServiceCatalogPage> {
  const now = deps.now ?? Date.now;
  const key = String(siteId);
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now()) return entry.page;
  const joined = inFlight.get(key);
  if (joined) return joined;
  // Definite-assignment assertion: the body only touches `load` after its
  // first await, by which point the assignment below has run.
  let load!: Promise<ServiceCatalogPage>;
  load = (async (): Promise<ServiceCatalogPage> => {
    // Yield one microtask FIRST so `load` is assigned and registered in
    // inFlight before any work runs — a synchronously-throwing stub would
    // otherwise reach the finally block while `load` is still in its TDZ.
    await undefined;
    try {
      const raw = await client.getPaginated(key, "/sale/services", {}, { maxPages: CATALOG_MAX_PAGES });
      const page: ServiceCatalogPage = { items: raw.items ?? [], complete: raw.complete !== false };
      // NEVER cache an incomplete page — see the module header.
      if (page.complete) {
        cache.set(key, { page, expiresAt: now() + CATALOG_TTL_MS, fetchedAt: now() });
      }
      return page;
    } catch (err) {
      // Stale-on-failure, BOUNDED.
      if (entry && now() - entry.fetchedAt <= CATALOG_MAX_STALE_MS) return entry.page;
      if (entry) {
        throw new Error(
          `Service catalog unavailable for site ${key}: /sale/services has failed for over 24h ` +
            `(last success ${new Date(entry.fetchedAt).toISOString()}). ${(err as Error).message}`,
        );
      }
      throw err;
    } finally {
      // Guarded delete: only remove OUR generation, never a successor's flight.
      if (inFlight.get(key) === load) inFlight.delete(key);
    }
  })();
  inFlight.set(key, load);
  return load;
}

/** Drop one site's cached catalog (e.g. after a known price-list change). */
export function invalidateCatalog(siteId: string): void {
  cache.delete(String(siteId));
}

/** Test hook: reset the memo AND the in-flight map to a cold start. */
export function clearCatalogCache(): void {
  cache.clear();
  inFlight.clear();
}
