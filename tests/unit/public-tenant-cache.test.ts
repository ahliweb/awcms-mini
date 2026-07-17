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

/**
 * Invalidation vs a loader that is ALREADY in flight (PR #847 review).
 *
 * Post-commit invalidation alone does not close this: `invalidate()` can only
 * delete what is already stored, while a loader that started BEFORE the commit
 * still holds a pre-commit snapshot and re-seats it afterwards with a full TTL.
 * The eviction is undone by a read that was already in the air, so the route's
 * carefully-ordered evict-after-commit is silently defeated.
 *
 * These are the tests whose absence let the race pass 4833 others.
 */
describe("invalidation beats a load that is already in flight", () => {
  test("a value read BEFORE the invalidation is never seated afterwards", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Loader started at t0, reading pre-commit state.
    const inFlight = getOrLoadTenantByHost("race.example.com", async () => {
      await gate;
      return "PRE_COMMIT";
    });

    // t1: the mutation commits, then the route invalidates. Nothing is stored
    // yet, so this delete is a no-op — that is the whole trap.
    invalidatePublicTenantHost("race.example.com");

    release!();
    // The in-flight caller still gets its answer: it asked before the change.
    expect(await inFlight).toBe("PRE_COMMIT");

    // But the NEXT request must not inherit it.
    const after = await getOrLoadTenantByHost(
      "race.example.com",
      async () => "POST_COMMIT"
    );
    expect(after).toBe("POST_COMMIT");
  });

  test("a NEGATIVE result read before verification does not keep the domain 404ing", async () => {
    // The concrete case `tenant/domains/[id]/verify.ts` documents as its
    // reason for invalidating at all: traffic arriving while the domain is
    // still pending_verification caches `null`.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = getOrLoadTenantByHost("newsite.example.com", async () => {
      await gate;
      return null;
    });

    invalidatePublicTenantHost("newsite.example.com");
    release!();
    expect(await inFlight).toBeNull();

    const afterVerification = await getOrLoadTenantByHost(
      "newsite.example.com",
      async () => "tenant-now-active"
    );
    expect(afterVerification).toBe("tenant-now-active");
  });

  test("a request arriving after the invalidation does not JOIN the pre-invalidation flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;

    const inFlight = getOrLoadTenantByHost("join.example.com", async () => {
      loads += 1;
      await gate;
      return "PRE_COMMIT";
    });

    invalidatePublicTenantHost("join.example.com");

    // Arrives after the commit+invalidate — must issue its own read rather
    // than adopting the answer of a query that read pre-commit state.
    const afterInvalidate = getOrLoadTenantByHost(
      "join.example.com",
      async () => {
        loads += 1;
        return "POST_COMMIT";
      }
    );

    release!();
    expect(await inFlight).toBe("PRE_COMMIT");
    expect(await afterInvalidate).toBe("POST_COMMIT");
    expect(loads).toBe(2);
  });

  test("BIDIRECTIONAL: single-flight still collapses concurrent cold reads when nothing invalidates", async () => {
    // Without this, "fixing" the race by disabling single-flight entirely
    // would pass every test above while throwing away the stampede
    // protection that is the reason this cache exists.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;

    const load = async () => {
      loads += 1;
      await gate;
      return "SHARED";
    };

    const a = getOrLoadTenantByHost("flight.example.com", load);
    const b = getOrLoadTenantByHost("flight.example.com", load);

    release!();
    expect(await a).toBe("SHARED");
    expect(await b).toBe("SHARED");
    expect(loads).toBe(1);
  });
});
