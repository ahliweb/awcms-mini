/**
 * In-process TTL cache for public tenant resolution (Issue #832, epic
 * #818). Every anonymous public request used to re-resolve host -> tenant
 * from the database, even though a domain -> tenant mapping changes on the
 * order of days, not seconds — 1-2 round trips added straight to TTFB on
 * the one path (`/news`, tenant-domain-routed public sites) that is most
 * TTFB-sensitive.
 *
 * **BINDING — why the cache key is the FULL normalized hostname and nothing
 * else.** This is a multi-tenant cache on an unauthenticated path: a wrong
 * key means tenant A's visitor is served tenant B's content. Two rules make
 * that structurally impossible here, and any future change must preserve
 * both:
 *
 * 1. This cache only ever memoizes `resolvePublicTenantByHost(sql, host)`,
 *    which is a **pure function of `host`** — it reads
 *    `awcms_mini_resolve_tenant_domain_lookup(host)` (migration 033) and
 *    nothing else. No session, no header, no env, no tenant context feeds
 *    the result, so `host` alone is a complete key. The moment a future
 *    change makes host resolution depend on any additional input, that
 *    input MUST become part of the key (or this cache must be removed).
 * 2. The key is the whole normalized hostname produced by
 *    `normalizePublicHost()` (lowercased, port-stripped, DNS-shape
 *    validated) — never a suffix, a label, a "subdomain part", or anything
 *    else derived from it. `a.example.com` and `b.example.com` are
 *    different tenants and must never share an entry.
 *
 * The `default` cache (env/setup-state fallback chain) is a **separate
 * instance**, not a reserved key inside the host cache — a reserved key
 * would be one typo away from colliding with a real hostname. There is
 * exactly one process-wide answer for that chain, so it needs no key at
 * all.
 *
 * **Negative results are cached too**, deliberately: an unmapped host is
 * exactly what bot/scanner traffic sends, and leaving it uncached would
 * mean the cheapest request to forge is also the only one that always hits
 * the database. `MAX_ENTRIES` bounds the resulting memory (see below).
 *
 * **Staleness bound is the TTL, not the explicit invalidation.** The
 * explicit `invalidatePublicTenantHost()` calls the tenant-domain API makes
 * after a mutation commits are a *same-process latency optimization* — they
 * cannot reach any other app instance's memory. In a multi-instance
 * deployment the real, honest guarantee is: a tenant-domain change becomes
 * visible everywhere within `PUBLIC_TENANT_CACHE_TTL_MS` (default 60s).
 * That is the contract documented in
 * `docs/awcms-mini/18_configuration_env_reference.md`; set the TTL to `0`
 * to disable caching entirely if an operator needs immediate propagation.
 */
import { log } from "../logging/logger";

/** Default TTL — the issue's own "~60s" (a domain mapping changes in days, not seconds). */
export const PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS = 60_000;

/**
 * Hard bound on distinct cached hostnames. Negative caching means an
 * attacker can otherwise mint an unbounded number of entries just by
 * varying the `Host` header. Eviction is plain FIFO (JS `Map` preserves
 * insertion order) — not LRU: an LRU needs a per-read write to reorder,
 * and this cache's whole point is being cheaper than a query. A legitimate
 * deployment maps tens of domains, not thousands, so the eviction path is
 * effectively dead code outside an attack; under an attack, FIFO degrades
 * to "no cache", i.e. today's behavior, never to a wrong answer.
 */
export const PUBLIC_TENANT_CACHE_MAX_ENTRIES = 1_000;

/**
 * `PUBLIC_TENANT_CACHE_TTL_MS`. `0` (or any negative/malformed value that
 * parses to <= 0) disables caching entirely — every lookup goes to the
 * database, exactly the pre-#832 behavior. Read per call rather than at
 * module load so tests can flip it without re-importing the module.
 */
export function resolvePublicTenantCacheTtlMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.PUBLIC_TENANT_CACHE_TTL_MS?.trim();

  if (!raw) {
    return PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    log("warning", "public_tenant_cache.invalid_ttl", {
      moduleKey: "tenant_domain",
      // Bounded: this is an operator-misconfiguration report, not a place
      // to echo an arbitrarily large env value into logs.
      valuePreview: raw.slice(0, 32)
    });

    return PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS;
  }

  return parsed;
}

type CacheEntry<T> = { value: T; expiresAt: number };

export type PublicTenantCacheStats = {
  hits: number;
  misses: number;
  entries: number;
  evictions: number;
};

/**
 * A single-flight TTL cache. "Single-flight" (the `inFlight` map) collapses
 * N concurrent cold lookups for the same key into ONE database round trip:
 * a cold cache under real traffic is a stampede, not a single miss — the
 * exact failure mode Issue #824 measured (a `readYamlCached` stampede, not
 * the query fan-out, turned out to dominate that endpoint's latency).
 * Without it, a cache flush under load would be strictly worse than no
 * cache at all.
 */
class SingleFlightTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const ttlMs = resolvePublicTenantCacheTtlMs();

    if (ttlMs <= 0) {
      // Caching disabled — no bookkeeping, no single-flight, no entry.
      return loader();
    }

    const now = Date.now();
    const cached = this.entries.get(key);

    if (cached && cached.expiresAt > now) {
      this.hits += 1;

      return cached.value;
    }

    if (cached) {
      // Expired — drop it now so a loader failure below can't leave a
      // stale entry sitting around looking fresh.
      this.entries.delete(key);
    }

    const pending = this.inFlight.get(key);

    if (pending) {
      // Someone else is already loading this exact key — join them rather
      // than issuing a duplicate query.
      this.hits += 1;

      return pending;
    }

    this.misses += 1;

    const promise = loader()
      .then((value) => {
        this.store(key, value, ttlMs);

        return value;
      })
      .finally(() => {
        // Always clear the in-flight slot, including on rejection —
        // otherwise one failed load would pin a rejected promise as the
        // permanent answer for this key.
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);

    return promise;
  }

  private store(key: string, value: T, ttlMs: number): void {
    if (this.entries.size >= PUBLIC_TENANT_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();

      if (!oldest.done) {
        this.entries.delete(oldest.value);
        this.evictions += 1;
      }
    }

    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  stats(): PublicTenantCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      evictions: this.evictions
    };
  }
}

/** Keyed by the FULL normalized hostname — see this file's binding note. */
const hostCache = new SingleFlightTtlCache<unknown>();
/**
 * Steps 2-3 (`PUBLIC_DEFAULT_TENANT_ID`/`_CODE`) and step 4
 * (`awcms_mini_setup_state`) each get their own instance. Both are keyless
 * by construction — each has exactly one process-wide answer — and both are
 * separate from `hostCache` rather than reserved keys inside it, so no
 * hostname can ever collide with them.
 */
const defaultFromEnvCache = new SingleFlightTtlCache<unknown>();
const defaultFromSetupStateCache = new SingleFlightTtlCache<unknown>();
const SINGLETON_KEY = "default";

/**
 * Memoizes host -> tenant. `normalizedHost` MUST already have been through
 * `normalizePublicHost()` (lowercased, port stripped, shape validated) —
 * caching a raw `Host` header value would key `Example.com`, `example.com`,
 * and `example.com:443` as three different entries and, worse, would cache
 * whatever unvalidated junk a client sent.
 */
export function getOrLoadTenantByHost<T>(
  normalizedHost: string,
  loader: () => Promise<T>
): Promise<T> {
  return hostCache.getOrLoad(normalizedHost, loader) as Promise<T>;
}

/** Memoizes the `PUBLIC_DEFAULT_TENANT_ID`/`_CODE` fallback (steps 2-3). */
export function getOrLoadDefaultTenantFromEnv<T>(
  loader: () => Promise<T>
): Promise<T> {
  return defaultFromEnvCache.getOrLoad(SINGLETON_KEY, loader) as Promise<T>;
}

/** Memoizes the `awcms_mini_setup_state.tenant_id` fallback (step 4). */
export function getOrLoadDefaultTenantFromSetupState<T>(
  loader: () => Promise<T>
): Promise<T> {
  return defaultFromSetupStateCache.getOrLoad(
    SINGLETON_KEY,
    loader
  ) as Promise<T>;
}

/**
 * Drops one hostname's cached resolution. Called by the tenant-domain API
 * after a mutating transaction has **committed** (never from inside the
 * transaction: a concurrent request could otherwise re-populate the cache
 * with the pre-commit value between the invalidation and the commit, and
 * nothing would invalidate it again).
 *
 * Over-invalidating is always safe (worst case: one extra query);
 * under-invalidating is the actual bug. When in doubt, call this.
 */
export function invalidatePublicTenantHost(normalizedHost: string): void {
  hostCache.invalidate(normalizedHost);
}

/**
 * Full flush. Used by the integration harness's `resetDatabase()` so a
 * process-lived cache can never leak one test's rows into the next, and
 * available to operators/scripts that change the default-tenant chain.
 */
export function resetPublicTenantCache(): void {
  hostCache.reset();
  defaultFromEnvCache.reset();
  defaultFromSetupStateCache.reset();
}

/** Test/observability only — never branch production behavior on this. */
export function getPublicTenantCacheStats(): {
  host: PublicTenantCacheStats;
  defaultFromEnv: PublicTenantCacheStats;
  defaultFromSetupState: PublicTenantCacheStats;
} {
  return {
    host: hostCache.stats(),
    defaultFromEnv: defaultFromEnvCache.stats(),
    defaultFromSetupState: defaultFromSetupStateCache.stats()
  };
}
