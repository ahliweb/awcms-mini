/**
 * Unit tests for the public tenant resolution cache (Issue #832, epic
 * #818). No database — the loader is a counting stub, which is exactly what
 * makes "did the cache actually prevent a second load?" provable rather
 * than assumed.
 *
 * The bidirectional rule these tests exist to enforce: a cache test that
 * only proves "the value came back" proves nothing (an always-miss cache
 * passes it too). Every behavior here is asserted from BOTH sides — the
 * cache serves without re-loading AND the underlying change still becomes
 * visible via TTL/invalidation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS,
  PUBLIC_TENANT_CACHE_MAX_ENTRIES,
  getOrLoadDefaultTenantFromEnv,
  getOrLoadDefaultTenantFromSetupState,
  getOrLoadTenantByHost,
  getPublicTenantCacheStats,
  invalidatePublicTenantHost,
  resetPublicTenantCache,
  resolvePublicTenantCacheTtlMs
} from "../../src/lib/tenant/public-tenant-cache";

const ORIGINAL_TTL_ENV = process.env.PUBLIC_TENANT_CACHE_TTL_MS;

/** A loader that records how many times it actually ran. */
function countingLoader<T>(value: T): {
  load: () => Promise<T>;
  calls: () => number;
} {
  let calls = 0;

  return {
    load: async () => {
      calls += 1;

      return value;
    },
    calls: () => calls
  };
}

beforeEach(() => {
  resetPublicTenantCache();
  delete process.env.PUBLIC_TENANT_CACHE_TTL_MS;
});

afterEach(() => {
  resetPublicTenantCache();

  if (ORIGINAL_TTL_ENV === undefined) {
    delete process.env.PUBLIC_TENANT_CACHE_TTL_MS;
  } else {
    process.env.PUBLIC_TENANT_CACHE_TTL_MS = ORIGINAL_TTL_ENV;
  }
});

describe("resolvePublicTenantCacheTtlMs", () => {
  test("defaults to 60s when unset", () => {
    expect(resolvePublicTenantCacheTtlMs({} as NodeJS.ProcessEnv)).toBe(
      PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS
    );
    expect(PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS).toBe(60_000);
  });

  test("honors an explicit value, including 0 (cache disabled)", () => {
    expect(
      resolvePublicTenantCacheTtlMs({
        PUBLIC_TENANT_CACHE_TTL_MS: "5000"
      } as NodeJS.ProcessEnv)
    ).toBe(5000);
    expect(
      resolvePublicTenantCacheTtlMs({
        PUBLIC_TENANT_CACHE_TTL_MS: "0"
      } as NodeJS.ProcessEnv)
    ).toBe(0);
  });

  test("falls back to the default (never throws) for malformed or negative values", () => {
    for (const raw of ["not-a-number", "-1", ""]) {
      expect(
        resolvePublicTenantCacheTtlMs({
          PUBLIC_TENANT_CACHE_TTL_MS: raw
        } as NodeJS.ProcessEnv)
      ).toBe(PUBLIC_TENANT_CACHE_DEFAULT_TTL_MS);
    }
  });
});

describe("getOrLoadTenantByHost — the cache actually prevents a second load", () => {
  test("a second lookup for the same host does NOT re-run the loader", async () => {
    const loader = countingLoader({ tenantId: "tenant-a" });

    const first = await getOrLoadTenantByHost("a.example.com", loader.load);
    const second = await getOrLoadTenantByHost("a.example.com", loader.load);

    expect(first).toEqual({ tenantId: "tenant-a" });
    expect(second).toEqual({ tenantId: "tenant-a" });
    // The whole point of the issue: one DB round trip, not two.
    expect(loader.calls()).toBe(1);
    expect(getPublicTenantCacheStats().host.hits).toBe(1);
    expect(getPublicTenantCacheStats().host.misses).toBe(1);
  });

  test("a NEGATIVE result is cached too (unmapped-host/bot traffic must not always hit the DB)", async () => {
    const loader = countingLoader(null);

    expect(
      await getOrLoadTenantByHost("bot-probe.example.com", loader.load)
    ).toBeNull();
    expect(
      await getOrLoadTenantByHost("bot-probe.example.com", loader.load)
    ).toBeNull();

    expect(loader.calls()).toBe(1);
  });
});

describe("getOrLoadTenantByHost — cross-tenant key isolation (the leak this cache could cause)", () => {
  test("different hosts never share an entry, even sharing a parent domain", async () => {
    const a = countingLoader({ tenantId: "tenant-a" });
    const b = countingLoader({ tenantId: "tenant-b" });

    await getOrLoadTenantByHost("a.example.com", a.load);
    await getOrLoadTenantByHost("b.example.com", b.load);

    // Re-read both: each must still get its OWN tenant back. A key built
    // from a suffix/label ("example.com") instead of the full hostname
    // would serve tenant A's row to tenant B's visitor here.
    expect(await getOrLoadTenantByHost("a.example.com", a.load)).toEqual({
      tenantId: "tenant-a"
    });
    expect(await getOrLoadTenantByHost("b.example.com", b.load)).toEqual({
      tenantId: "tenant-b"
    });
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  test("the host cache and the default-tenant caches are separate namespaces", async () => {
    const host = countingLoader({ tenantId: "from-host" });
    const env = countingLoader({ tenantId: "from-env" });
    const setup = countingLoader({ tenantId: "from-setup" });

    // "default" is the internal singleton key of the two default caches —
    // a host literally named `default` must not collide with either.
    expect(await getOrLoadTenantByHost("default", host.load)).toEqual({
      tenantId: "from-host"
    });
    expect(await getOrLoadDefaultTenantFromEnv(env.load)).toEqual({
      tenantId: "from-env"
    });
    expect(await getOrLoadDefaultTenantFromSetupState(setup.load)).toEqual({
      tenantId: "from-setup"
    });
  });
});

describe("getOrLoadTenantByHost — changes stay visible (the other direction)", () => {
  test("invalidatePublicTenantHost forces the next lookup to re-load", async () => {
    let current: { tenantId: string } | null = { tenantId: "tenant-a" };
    let calls = 0;
    const load = async () => {
      calls += 1;

      return current;
    };

    expect(await getOrLoadTenantByHost("moving.example.com", load)).toEqual({
      tenantId: "tenant-a"
    });

    // Simulate the domain being suspended/soft-deleted in the database.
    current = null;

    // Without invalidation the stale value is still served — this asserts
    // the cache is real, and that the invalidation below is what fixes it.
    expect(await getOrLoadTenantByHost("moving.example.com", load)).toEqual({
      tenantId: "tenant-a"
    });
    expect(calls).toBe(1);

    invalidatePublicTenantHost("moving.example.com");

    expect(await getOrLoadTenantByHost("moving.example.com", load)).toBeNull();
    expect(calls).toBe(2);
  });

  test("invalidating one host leaves every other host's entry intact", async () => {
    const a = countingLoader({ tenantId: "tenant-a" });
    const b = countingLoader({ tenantId: "tenant-b" });

    await getOrLoadTenantByHost("a.example.com", a.load);
    await getOrLoadTenantByHost("b.example.com", b.load);

    invalidatePublicTenantHost("a.example.com");

    await getOrLoadTenantByHost("a.example.com", a.load);
    await getOrLoadTenantByHost("b.example.com", b.load);

    expect(a.calls()).toBe(2); // evicted -> re-loaded
    expect(b.calls()).toBe(1); // untouched -> still cached
  });

  test("an entry expires after the TTL, so a change propagates with no explicit invalidation", async () => {
    // The real multi-instance guarantee: another app instance's mutation
    // cannot reach this process's memory, so the TTL — not the explicit
    // eviction — is the actual staleness bound that must hold.
    process.env.PUBLIC_TENANT_CACHE_TTL_MS = "30";

    let current: { tenantId: string } | null = { tenantId: "tenant-a" };
    let calls = 0;
    const load = async () => {
      calls += 1;

      return current;
    };

    expect(await getOrLoadTenantByHost("ttl.example.com", load)).toEqual({
      tenantId: "tenant-a"
    });

    current = { tenantId: "tenant-b" };

    // Still within the TTL -> deliberately stale.
    expect(await getOrLoadTenantByHost("ttl.example.com", load)).toEqual({
      tenantId: "tenant-a"
    });
    expect(calls).toBe(1);

    await Bun.sleep(50);

    expect(await getOrLoadTenantByHost("ttl.example.com", load)).toEqual({
      tenantId: "tenant-b"
    });
    expect(calls).toBe(2);
  });

  test("TTL=0 disables caching entirely — every lookup re-loads", async () => {
    process.env.PUBLIC_TENANT_CACHE_TTL_MS = "0";
    const loader = countingLoader({ tenantId: "tenant-a" });

    await getOrLoadTenantByHost("nocache.example.com", loader.load);
    await getOrLoadTenantByHost("nocache.example.com", loader.load);
    await getOrLoadTenantByHost("nocache.example.com", loader.load);

    expect(loader.calls()).toBe(3);
    expect(getPublicTenantCacheStats().host.entries).toBe(0);
  });
});

describe("getOrLoadTenantByHost — single flight and failure handling", () => {
  test("N concurrent cold lookups for one host collapse into ONE load", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      await Bun.sleep(20);

      return { tenantId: "tenant-a" };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        getOrLoadTenantByHost("stampede.example.com", load)
      )
    );

    // A cold cache under real traffic is a stampede, not one miss.
    expect(calls).toBe(1);
    for (const result of results) {
      expect(result).toEqual({ tenantId: "tenant-a" });
    }
  });

  test("a rejected load is not cached and does not poison the key", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("database unavailable");
      }

      return { tenantId: "tenant-a" };
    };

    // Deliberately try/catch rather than `.rejects.toThrow()` — see
    // `.claude` memory `bun-test-expect-resolves-rejects-hang`.
    let caught: unknown = null;

    try {
      await getOrLoadTenantByHost("flaky.example.com", load);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);

    // The failure must not be pinned as this key's permanent answer.
    expect(await getOrLoadTenantByHost("flaky.example.com", load)).toEqual({
      tenantId: "tenant-a"
    });
    expect(calls).toBe(2);
  });
});

describe("getOrLoadTenantByHost — bounded memory", () => {
  test("negative caching cannot grow past MAX_ENTRIES (Host-header flood)", async () => {
    // An attacker varying the Host header must not be able to mint
    // unbounded cache entries.
    for (
      let index = 0;
      index < PUBLIC_TENANT_CACHE_MAX_ENTRIES + 50;
      index += 1
    ) {
      await getOrLoadTenantByHost(
        `flood-${index}.example.com`,
        async () => null
      );
    }

    const stats = getPublicTenantCacheStats().host;

    expect(stats.entries).toBeLessThanOrEqual(PUBLIC_TENANT_CACHE_MAX_ENTRIES);
    expect(stats.evictions).toBeGreaterThan(0);
  });
});
