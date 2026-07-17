/**
 * Integration tests for the public tenant resolution cache (Issue #832,
 * epic #818) against a real PostgreSQL.
 *
 * `tests/unit/public-tenant-cache.test.ts` proves the cache primitive in
 * isolation. This file proves the thing that actually matters and that a
 * unit test structurally cannot: that the PRODUCTION path —
 * `resolvePublicTenantFromRequest` with its real `defaultDeps` — is wired
 * to that cache. A correct cache module that nothing calls is a no-op (the
 * "validator exists but unwired" failure mode this repo has shipped
 * before), so every assertion here counts REAL queries against a REAL
 * database through the real entry point.
 *
 * Every test asserts BOTH directions, because a one-directional cache test
 * is worthless: an always-miss cache passes "the right tenant came back",
 * and an always-hit cache passes "the second call was free". Only asserting
 * that the cache prevents the second query AND that a domain change still
 * becomes visible proves the cache is both real and correct.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { resolvePublicTenantFromRequest } from "../../src/lib/tenant/public-host-tenant-resolver";
import {
  getPublicTenantCacheStats,
  invalidatePublicTenantHost,
  resetPublicTenantCache
} from "../../src/lib/tenant/public-tenant-cache";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
}

async function insertDomain(
  tenantId: string,
  hostname: string,
  status = "active"
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenant_domains
      (tenant_id, hostname, normalized_hostname, domain_type, status)
    VALUES (${tenantId}, ${hostname}, ${hostname.toLowerCase()}, 'custom_domain', ${status})
  `;
}

/**
 * Wraps the real sql client so every tagged-template query it issues is
 * counted — the same proxy technique
 * `public-tenant-resolution.integration.test.ts` uses for its
 * timing-side-channel proof. This is what makes "the cache prevented a
 * database round trip" an observation instead of an assumption.
 */
function countingSql(): {
  sql: Bun.SQL;
  count: () => number;
  reset: () => void;
} {
  const base = getTestSql();
  let calls = 0;

  const proxy = new Proxy(base, {
    apply(target, thisArg, args) {
      calls += 1;

      return Reflect.apply(
        target as unknown as (...a: unknown[]) => unknown,
        thisArg,
        args
      );
    }
  }) as unknown as Bun.SQL;

  return { sql: proxy, count: () => calls, reset: () => (calls = 0) };
}

function requestForHost(host: string): Request {
  return new Request("http://ignored.test/news", { headers: { host } });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("public tenant resolution cache — production path (Issue #832)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    // resetDatabase() also clears the cache (see harness) — repeated here
    // to make this suite's dependence on a cold cache explicit rather than
    // inherited by luck.
    await resetDatabase();
    resetPublicTenantCache();
    await seedTenants();
    delete process.env.PUBLIC_TENANT_CACHE_TTL_MS;
  });

  test("the cache really prevents the second query — and still returns the right tenant", async () => {
    await insertDomain(TENANT_A, "cached.example.com");

    const counting = countingSql();

    const first = await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("cached.example.com"),
      { mode: "host_default" }
    );
    const queriesAfterFirst = counting.count();

    const second = await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("cached.example.com"),
      { mode: "host_default" }
    );
    const queriesAfterSecond = counting.count();

    // Direction 1 — correctness: both calls resolve the real tenant.
    expect(first?.tenantId).toBe(TENANT_A);
    expect(second?.tenantId).toBe(TENANT_A);

    // Direction 2 — the cache is real: the first call queried, the second
    // added ZERO queries. This is the TTFB win the issue asks for; before
    // this change both numbers were 1.
    expect(queriesAfterFirst).toBe(1);
    expect(queriesAfterSecond).toBe(1);
    expect(getPublicTenantCacheStats().host.hits).toBe(1);
  });

  test("an unresolvable host is negatively cached — the fallback chain stops re-querying too", async () => {
    const counting = countingSql();

    const first = await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("unmapped.example.com"),
      { mode: "host_default" }
    );
    const queriesAfterFirst = counting.count();

    const second = await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("unmapped.example.com"),
      { mode: "host_default" }
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
    // 2 cold queries, then zero forever. The breakdown, since it is not
    // obvious: host lookup (1) + env fallback (0 — with neither
    // PUBLIC_DEFAULT_TENANT_ID nor _CODE set it short-circuits in memory
    // without querying) + setup-state fallback (1). Bot/scanner traffic
    // hitting unmapped hosts was previously the cheapest possible way to
    // force database round trips on every single hit; now it is free after
    // the first.
    expect(queriesAfterFirst).toBe(2);
    expect(counting.count()).toBe(2);
  });

  test("two hosts on the same parent domain never bleed into each other", async () => {
    // The cross-tenant leak this cache could cause if the key were ever a
    // suffix/label rather than the full hostname. This is an anonymous,
    // unauthenticated path — a wrong key here serves tenant B's site to
    // tenant A's visitors.
    await insertDomain(TENANT_A, "a.shared.example.com");
    await insertDomain(TENANT_B, "b.shared.example.com");

    const sql = getTestSql();

    // Warm both, then re-read both from cache.
    await resolvePublicTenantFromRequest(
      sql,
      requestForHost("a.shared.example.com"),
      {
        mode: "host_default"
      }
    );
    await resolvePublicTenantFromRequest(
      sql,
      requestForHost("b.shared.example.com"),
      {
        mode: "host_default"
      }
    );

    const a = await resolvePublicTenantFromRequest(
      sql,
      requestForHost("a.shared.example.com"),
      { mode: "host_default" }
    );
    const b = await resolvePublicTenantFromRequest(
      sql,
      requestForHost("b.shared.example.com"),
      { mode: "host_default" }
    );

    expect(a?.tenantId).toBe(TENANT_A);
    expect(a?.tenantCode).toBe("tenant-a");
    expect(b?.tenantId).toBe(TENANT_B);
    expect(b?.tenantCode).toBe("tenant-b");
  });

  test("a host with a port hits the same cache entry as the bare host (normalized key)", async () => {
    await insertDomain(TENANT_A, "ported.example.com");

    const counting = countingSql();

    await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("ported.example.com"),
      { mode: "host_default" }
    );
    counting.reset();

    const withPort = await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("ported.example.com:4321"),
      { mode: "host_default" }
    );

    // Keyed AFTER normalization — otherwise `example.com` and
    // `example.com:4321` would be two entries with two round trips, and
    // `Example.com` a third.
    expect(withPort?.tenantId).toBe(TENANT_A);
    expect(counting.count()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Acceptance: "perubahan tenant domain tetap terlihat setelah TTL/
  // invalidasi" — proven against real DB mutations, from both sides.
  // ---------------------------------------------------------------------

  test("suspending a domain becomes visible after invalidation (and is correctly stale before it)", async () => {
    await insertDomain(TENANT_A, "suspend-me.example.com");

    const sql = getTestSql();

    expect(
      (
        await resolvePublicTenantFromRequest(
          sql,
          requestForHost("suspend-me.example.com"),
          { mode: "host_default" }
        )
      )?.tenantId
    ).toBe(TENANT_A);

    await getAdminSql()`
      UPDATE awcms_mini_tenant_domains SET status = 'suspended'
      WHERE normalized_hostname = 'suspend-me.example.com'
    `;

    // Before invalidation: deliberately stale. Asserting this is what makes
    // the assertion after it meaningful — it proves the resolver is reading
    // the cache and not the database.
    expect(
      await resolvePublicTenantFromRequest(
        sql,
        requestForHost("suspend-me.example.com"),
        { mode: "host_default" }
      )
    ).not.toBeNull();

    invalidatePublicTenantHost("suspend-me.example.com");

    // After invalidation: the real, current database state.
    expect(
      await resolvePublicTenantFromRequest(
        sql,
        requestForHost("suspend-me.example.com"),
        { mode: "host_default" }
      )
    ).toBeNull();
  });

  test("a newly verified domain resolves after invalidation, despite an earlier negative cache entry", async () => {
    // The real operator sequence: traffic arrives at a host before it is
    // verified (caching a null), the domain is then verified, and it must
    // start resolving. This is the case where a naive cache silently 404s a
    // freshly verified domain.
    await insertDomain(
      TENANT_A,
      "verify-me.example.com",
      "pending_verification"
    );

    const sql = getTestSql();

    expect(
      await resolvePublicTenantFromRequest(
        sql,
        requestForHost("verify-me.example.com"),
        { mode: "host_default" }
      )
    ).toBeNull();

    await getAdminSql()`
      UPDATE awcms_mini_tenant_domains SET status = 'active', verified_at = now()
      WHERE normalized_hostname = 'verify-me.example.com'
    `;

    expect(
      await resolvePublicTenantFromRequest(
        sql,
        requestForHost("verify-me.example.com"),
        { mode: "host_default" }
      )
    ).toBeNull(); // still the cached negative

    invalidatePublicTenantHost("verify-me.example.com");

    expect(
      (
        await resolvePublicTenantFromRequest(
          sql,
          requestForHost("verify-me.example.com"),
          { mode: "host_default" }
        )
      )?.tenantId
    ).toBe(TENANT_A);
  });

  test("re-pointing a hostname to another tenant is visible after invalidation — never serves the old tenant", async () => {
    await insertDomain(TENANT_A, "moving.example.com");

    const sql = getTestSql();

    expect(
      (
        await resolvePublicTenantFromRequest(
          sql,
          requestForHost("moving.example.com"),
          { mode: "host_default" }
        )
      )?.tenantId
    ).toBe(TENANT_A);

    // Delete + recreate is the documented way to re-point a hostname
    // (hostname is immutable on an existing row — see updateTenantDomain).
    await getAdminSql()`
      UPDATE awcms_mini_tenant_domains
      SET deleted_at = now(), delete_reason = 'repointing', is_primary = false
      WHERE normalized_hostname = 'moving.example.com'
    `;
    await insertDomain(TENANT_B, "moving.example.com");

    invalidatePublicTenantHost("moving.example.com");

    const after = await resolvePublicTenantFromRequest(
      sql,
      requestForHost("moving.example.com"),
      { mode: "host_default" }
    );

    // The cross-tenant failure this cache must never cause.
    expect(after?.tenantId).toBe(TENANT_B);
    expect(after?.tenantCode).toBe("tenant-b");
  });

  test("a domain change propagates via TTL expiry alone, with NO explicit invalidation", async () => {
    // The honest multi-instance guarantee: one app instance's mutation
    // cannot evict another instance's memory, so the TTL — not the
    // invalidation call — is the real staleness bound.
    process.env.PUBLIC_TENANT_CACHE_TTL_MS = "50";

    await insertDomain(TENANT_A, "ttl-bound.example.com");

    const sql = getTestSql();

    expect(
      (
        await resolvePublicTenantFromRequest(
          sql,
          requestForHost("ttl-bound.example.com"),
          { mode: "host_default" }
        )
      )?.tenantId
    ).toBe(TENANT_A);

    await getAdminSql()`
      UPDATE awcms_mini_tenant_domains SET status = 'suspended'
      WHERE normalized_hostname = 'ttl-bound.example.com'
    `;

    await Bun.sleep(80);

    expect(
      await resolvePublicTenantFromRequest(
        sql,
        requestForHost("ttl-bound.example.com"),
        { mode: "host_default" }
      )
    ).toBeNull();
  });

  test("PUBLIC_TENANT_CACHE_TTL_MS=0 restores the pre-#832 always-query behavior", async () => {
    process.env.PUBLIC_TENANT_CACHE_TTL_MS = "0";

    await insertDomain(TENANT_A, "nocache.example.com");

    const counting = countingSql();

    await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("nocache.example.com"),
      { mode: "host_default" }
    );
    const afterFirst = counting.count();

    await resolvePublicTenantFromRequest(
      counting.sql,
      requestForHost("nocache.example.com"),
      { mode: "host_default" }
    );

    // An operator who needs immediate propagation can opt out entirely.
    expect(afterFirst).toBe(1);
    expect(counting.count()).toBe(2);
  });

  /**
   * Cross-module invalidation (PR #847 review).
   *
   * The cache's own note calls the resolution "a pure function of host" —
   * true of the KEY, but not of the VALUE: `public-host-tenant-resolver.ts`
   * selects `tenant_status, tenant_code, tenant_name, default_locale` from
   * `awcms_mini_tenants`, a table the `tenant_admin` settings module mutates
   * and the `tenant_domain` module never touches. Modelling the cache as
   * owned by `tenant_domain` alone leaves that edit invisible for a full TTL,
   * where before the cache it was correct on the very next request.
   */
  test("a tenant_name edit is visible to the PUBLIC resolver, not stuck behind the TTL", async () => {
    await insertDomain(TENANT_A, "rename.example.com");
    const admin = getAdminSql();

    const before = await resolvePublicTenantFromRequest(
      getTestSql(),
      requestForHost("rename.example.com"),
      { mode: "host_default" }
    );
    expect(before?.tenantName).toBe("Tenant A");

    // The settings route's write + its post-commit eviction.
    await admin`
      UPDATE awcms_mini_tenants SET tenant_name = 'Renamed A' WHERE id = ${TENANT_A}
    `;
    invalidatePublicTenantHost("rename.example.com");

    const after = await resolvePublicTenantFromRequest(
      getTestSql(),
      requestForHost("rename.example.com"),
      { mode: "host_default" }
    );
    expect(after?.tenantName).toBe("Renamed A");
  });

  test("BIDIRECTIONAL: without the eviction the rename is INVISIBLE — proving the eviction is what makes it work, not the TTL", async () => {
    await insertDomain(TENANT_A, "stale.example.com");
    const admin = getAdminSql();

    const before = await resolvePublicTenantFromRequest(
      getTestSql(),
      requestForHost("stale.example.com"),
      { mode: "host_default" }
    );
    expect(before?.tenantName).toBe("Tenant A");

    await admin`
      UPDATE awcms_mini_tenants SET tenant_name = 'Renamed A' WHERE id = ${TENANT_A}
    `;
    // Deliberately NO invalidatePublicTenantHost — this is the pre-fix
    // behaviour, pinned so the test above cannot pass for the wrong reason
    // (e.g. if caching silently stopped working at all).
    const stillStale = await resolvePublicTenantFromRequest(
      getTestSql(),
      requestForHost("stale.example.com"),
      { mode: "host_default" }
    );
    expect(stillStale?.tenantName).toBe("Tenant A");
  });
});
