/**
 * Integration tests for the public host tenant resolver (Issue #559, epic
 * #555) against a real PostgreSQL. Exercises every acceptance criterion in
 * the issue end-to-end, including the RLS/SECURITY DEFINER bootstrap
 * mechanism (migration 033) — proving it is a deliberate, narrow bypass,
 * not an accidental RLS leak (same pattern
 * `tenant-domain-schema.integration.test.ts` used for the schema itself).
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

import {
  normalizePublicHost,
  resolveDefaultPublicTenantFromEnv,
  resolveDefaultPublicTenantFromSetupState,
  resolvePublicTenantByHost,
  resolvePublicTenantFromRequest
} from "../../src/lib/tenant/public-host-tenant-resolver";

const TENANT_ACTIVE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_INACTIVE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_ACTIVE}, 'tenant-active', 'Tenant Active', 'Tenant Active Legal', 'active', 'en', 'light'),
      (${TENANT_INACTIVE}, 'tenant-inactive', 'Tenant Inactive', 'Tenant Inactive Legal', 'suspended', 'en', 'light')
  `;
}

async function insertDomain(
  tenantId: string,
  hostname: string,
  overrides: Partial<{
    status: string;
    domainType: string;
    isPrimary: boolean;
    deleted: boolean;
  }> = {}
): Promise<void> {
  const admin = getAdminSql();
  const normalized = hostname.toLowerCase().trim();
  await admin`
    INSERT INTO awcms_mini_tenant_domains
      (tenant_id, hostname, normalized_hostname, domain_type, status, is_primary, deleted_at, deleted_by, delete_reason)
    VALUES (
      ${tenantId},
      ${hostname},
      ${normalized},
      ${overrides.domainType ?? "custom_domain"},
      ${overrides.status ?? "active"},
      ${overrides.isPrimary ?? false},
      ${overrides.deleted ? new Date() : null},
      ${overrides.deleted ? TENANT_ACTIVE : null},
      ${overrides.deleted ? "test cleanup" : null}
    )
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("public host tenant resolver — end-to-end (Issue #559)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  // ---------------------------------------------------------------------
  // Acceptance: custom domain and subdomain resolve identically.
  // ---------------------------------------------------------------------

  test("a custom domain resolves to the active tenant mapped to that host", async () => {
    await insertDomain(TENANT_ACTIVE, "domain.com", {
      domainType: "custom_domain"
    });

    const sql = getTestSql();
    const result = await resolvePublicTenantByHost(sql, "domain.com");

    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe(TENANT_ACTIVE);
    expect(result?.tenantCode).toBe("tenant-active");
  });

  test("a platform subdomain resolves the same way as a custom domain (no special-casing)", async () => {
    await insertDomain(TENANT_ACTIVE, "subdomain.platform.com", {
      domainType: "subdomain"
    });

    const sql = getTestSql();
    const result = await resolvePublicTenantByHost(
      sql,
      "subdomain.platform.com"
    );

    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  // ---------------------------------------------------------------------
  // Acceptance: hostnames with ports normalize correctly before lookup.
  // ---------------------------------------------------------------------

  test("a hostname with a port is normalized (port stripped) before resolution", async () => {
    await insertDomain(TENANT_ACTIVE, "example.com");

    const sql = getTestSql();
    const normalized = normalizePublicHost("example.com:4321");
    expect(normalized).toBe("example.com");

    const result = await resolvePublicTenantByHost(sql, normalized as string);
    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("resolvePublicTenantFromRequest end-to-end with a ported Host header", async () => {
    await insertDomain(TENANT_ACTIVE, "example.com");

    const sql = getTestSql();
    const request = new Request("http://ignored.test/", {
      headers: { host: "example.com:4321" }
    });

    const result = await resolvePublicTenantFromRequest(sql, request, {
      mode: "host_default"
    });

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  // ---------------------------------------------------------------------
  // Acceptance: non-active domain statuses never resolve tenant traffic.
  // ---------------------------------------------------------------------

  for (const status of ["pending_verification", "suspended", "failed"]) {
    test(`a domain with status "${status}" does not resolve tenant traffic`, async () => {
      await insertDomain(TENANT_ACTIVE, "not-active.com", { status });

      const sql = getTestSql();
      const result = await resolvePublicTenantByHost(sql, "not-active.com");

      expect(result).toBeNull();
    });
  }

  test("a soft-deleted domain does not resolve tenant traffic", async () => {
    await insertDomain(TENANT_ACTIVE, "deleted-domain.com", { deleted: true });

    const sql = getTestSql();
    const result = await resolvePublicTenantByHost(sql, "deleted-domain.com");

    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Acceptance: inactive tenant behind an active domain -> generic null,
  // identical to an unknown host (no distinguishable signal).
  // ---------------------------------------------------------------------

  test("an active domain mapped to an inactive tenant resolves to null (generic 404)", async () => {
    await insertDomain(TENANT_INACTIVE, "inactive-tenant.com");

    const sql = getTestSql();
    const resultForInactiveTenant = await resolvePublicTenantByHost(
      sql,
      "inactive-tenant.com"
    );
    const resultForUnknownHost = await resolvePublicTenantByHost(
      sql,
      "totally-unknown-host.com"
    );

    expect(resultForInactiveTenant).toBeNull();
    expect(resultForUnknownHost).toBeNull();
    // Both failure modes are indistinguishable `null` — no differing shape,
    // no thrown error, no extra field revealing which case it was.
    expect(resultForInactiveTenant).toEqual(resultForUnknownHost);
  });

  // ---------------------------------------------------------------------
  // Acceptance: unknown host only falls back when mode allows it; the
  // env/setup fallback chain (steps 2-4) always runs regardless of mode.
  // ---------------------------------------------------------------------

  test("mode=host_default: unknown host falls through to PUBLIC_DEFAULT_TENANT_ID", async () => {
    const sql = getTestSql();
    const request = new Request("http://ignored.test/", {
      headers: { host: "unmapped-host.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      sql,
      request,
      { mode: "host_default" },
      undefined
    );

    // No PUBLIC_DEFAULT_TENANT_ID/CODE/setup_state configured yet -> null.
    expect(result).toBeNull();

    // Now prove the fallback chain actually works when env default IS set:
    // resolveDefaultPublicTenantFromEnv is called with an explicit env
    // object below (steps 2-3), independent from resolvePublicTenantFromRequest's
    // internal default of `process.env` (that composition is covered by the
    // unit test suite's mocked-deps tests).
    const envResult = await resolveDefaultPublicTenantFromEnv(sql, {
      PUBLIC_DEFAULT_TENANT_ID: TENANT_ACTIVE
    } as NodeJS.ProcessEnv);

    expect(envResult?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("mode unset (offline/LAN default): host step never runs, but env/setup fallback still does", async () => {
    await insertDomain(TENANT_ACTIVE, "would-have-matched.com");

    const sql = getTestSql();
    const request = new Request("http://ignored.test/", {
      headers: { host: "would-have-matched.com" }
    });

    // No mode configured at all -> host lookup step is skipped entirely,
    // even though a matching active domain row exists.
    const result = await resolvePublicTenantFromRequest(sql, request, {});

    expect(result).toBeNull();
  });

  test("if truly no step resolves a tenant, the result is a generic null (404)", async () => {
    const sql = getTestSql();
    const request = new Request("http://ignored.test/", {
      headers: { host: "nothing-matches-anywhere.com" }
    });

    const result = await resolvePublicTenantFromRequest(sql, request, {
      mode: "host_default"
    });

    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Acceptance: resolveDefaultPublicTenantFromEnv tries ID, then CODE.
  // ---------------------------------------------------------------------

  test("resolveDefaultPublicTenantFromEnv: PUBLIC_DEFAULT_TENANT_ID takes priority over CODE", async () => {
    const sql = getTestSql();

    const result = await resolveDefaultPublicTenantFromEnv(sql, {
      PUBLIC_DEFAULT_TENANT_ID: TENANT_ACTIVE,
      PUBLIC_DEFAULT_TENANT_CODE: "tenant-inactive"
    } as NodeJS.ProcessEnv);

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("resolveDefaultPublicTenantFromEnv: falls back to CODE when ID is unset", async () => {
    const sql = getTestSql();

    const result = await resolveDefaultPublicTenantFromEnv(sql, {
      PUBLIC_DEFAULT_TENANT_CODE: "tenant-active"
    } as NodeJS.ProcessEnv);

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("resolveDefaultPublicTenantFromEnv: falls back to CODE when ID points at an inactive tenant", async () => {
    const sql = getTestSql();

    const result = await resolveDefaultPublicTenantFromEnv(sql, {
      PUBLIC_DEFAULT_TENANT_ID: TENANT_INACTIVE,
      PUBLIC_DEFAULT_TENANT_CODE: "tenant-active"
    } as NodeJS.ProcessEnv);

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("resolveDefaultPublicTenantFromEnv: an inactive tenant behind PUBLIC_DEFAULT_TENANT_CODE resolves to null", async () => {
    const sql = getTestSql();

    const result = await resolveDefaultPublicTenantFromEnv(sql, {
      PUBLIC_DEFAULT_TENANT_CODE: "tenant-inactive"
    } as NodeJS.ProcessEnv);

    expect(result).toBeNull();
  });

  test("resolveDefaultPublicTenantFromEnv: malformed PUBLIC_DEFAULT_TENANT_ID never throws, falls through to CODE", async () => {
    const sql = getTestSql();

    const result = await resolveDefaultPublicTenantFromEnv(sql, {
      PUBLIC_DEFAULT_TENANT_ID: "not-a-uuid",
      PUBLIC_DEFAULT_TENANT_CODE: "tenant-active"
    } as NodeJS.ProcessEnv);

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  // ---------------------------------------------------------------------
  // Acceptance: resolveDefaultPublicTenantFromSetupState reads
  // awcms_mini_setup_state.tenant_id.
  // ---------------------------------------------------------------------

  test("resolveDefaultPublicTenantFromSetupState resolves the tenant recorded during setup", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_setup_state (id, tenant_id)
      VALUES (true, ${TENANT_ACTIVE})
      ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
    `;

    const sql = getTestSql();
    const result = await resolveDefaultPublicTenantFromSetupState(sql);

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("resolveDefaultPublicTenantFromSetupState returns null when no setup_state row/tenant is recorded", async () => {
    const sql = getTestSql();
    const result = await resolveDefaultPublicTenantFromSetupState(sql);

    expect(result).toBeNull();
  });

  test("resolveDefaultPublicTenantFromSetupState returns null when the recorded tenant is inactive", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_setup_state (id, tenant_id)
      VALUES (true, ${TENANT_INACTIVE})
      ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
    `;

    const sql = getTestSql();
    const result = await resolveDefaultPublicTenantFromSetupState(sql);

    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Acceptance: X-Forwarded-Host ignored unless PUBLIC_TRUST_PROXY=true.
  // ---------------------------------------------------------------------

  test("X-Forwarded-Host is ignored by default (trustProxy not set)", async () => {
    await insertDomain(TENANT_ACTIVE, "real-host.com");
    await insertDomain(TENANT_INACTIVE, "spoofed-host.com");

    const sql = getTestSql();
    const request = new Request("http://ignored.test/", {
      headers: {
        host: "real-host.com",
        "x-forwarded-host": "spoofed-host.com"
      }
    });

    const result = await resolvePublicTenantFromRequest(sql, request, {
      mode: "host_default"
    });

    expect(result?.tenantId).toBe(TENANT_ACTIVE);
  });

  test("X-Forwarded-Host is honored only when trustProxy=true", async () => {
    await insertDomain(TENANT_ACTIVE, "edge-proxy.internal");
    await insertDomain(TENANT_INACTIVE, "public-facing.example.com");
    // Give the forwarded-host tenant an active status too, to prove the
    // header really is what drove resolution (not just "both are null").
    await getAdminSql()`
      UPDATE awcms_mini_tenants SET status = 'active' WHERE id = ${TENANT_INACTIVE}
    `;

    const sql = getTestSql();
    const request = new Request("http://ignored.test/", {
      headers: {
        host: "edge-proxy.internal",
        "x-forwarded-host": "public-facing.example.com"
      }
    });

    const result = await resolvePublicTenantFromRequest(sql, request, {
      mode: "host_default",
      trustProxy: true
    });

    expect(result?.tenantId).toBe(TENANT_INACTIVE);
  });

  // ---------------------------------------------------------------------
  // Acceptance / security note: the SECURITY DEFINER function is a
  // deliberate, narrow bypass — not an accidental RLS leak. Proven by
  // showing (a) the function works from the least-privilege app role with
  // NO tenant GUC set, and (b) a direct SELECT on the underlying table from
  // that same role/session still returns zero rows without the function.
  // ---------------------------------------------------------------------

  test("the SECURITY DEFINER lookup function resolves rows via awcms_mini_app with no app.current_tenant_id GUC set", async () => {
    await insertDomain(TENANT_ACTIVE, "bootstrap-check.com");

    const sql = getTestSql();

    const guc = (await sql`
      SELECT current_setting('app.current_tenant_id', true) AS tenant_guc
    `) as { tenant_guc: string | null }[];
    // The fail-closed default GUC (migration 013) — proves no withTenant(...)
    // transaction/SET LOCAL happened in this session.
    expect(guc[0]?.tenant_guc).toBe("00000000-0000-0000-0000-000000000000");

    const rows = (await sql`
      SELECT tenant_id, domain_status, tenant_status
      FROM awcms_mini_resolve_tenant_domain_lookup('bootstrap-check.com')
    `) as { tenant_id: string; domain_status: string; tenant_status: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT_ACTIVE);
    expect(rows[0]?.domain_status).toBe("active");
    expect(rows[0]?.tenant_status).toBe("active");
  });

  test("a direct SELECT on awcms_mini_tenant_domains from the same app-role session (no function) still returns zero rows", async () => {
    await insertDomain(TENANT_ACTIVE, "bootstrap-check-direct.com");

    const sql = getTestSql();
    const rows = await sql`
      SELECT normalized_hostname FROM awcms_mini_tenant_domains
      WHERE normalized_hostname = 'bootstrap-check-direct.com'
    `;

    // This is the exact fail-closed behavior migration 031 documented as
    // "correct and required" — the SECURITY DEFINER function above is the
    // one sanctioned exception, not a general RLS bypass for this role.
    expect(rows).toHaveLength(0);
  });

  test("the lookup function never returns verification_token_hash or raw hostname columns", async () => {
    await insertDomain(TENANT_ACTIVE, "narrow-surface-check.com");

    const sql = getTestSql();
    const rows = (await sql`
      SELECT * FROM awcms_mini_resolve_tenant_domain_lookup('narrow-surface-check.com')
    `) as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    const columns = Object.keys(rows[0] ?? {});
    // The tenant_* columns (status/code/name/locale) were added to close a
    // timing side-channel (see migration 033's comment): they let
    // resolvePublicTenantByHost finish in exactly one round trip instead of
    // a conditional second query, and they expose nothing that wasn't
    // already unconditionally public on the RLS-free awcms_mini_tenants
    // table (ADR-0003/migration 013).
    expect(columns.sort()).toEqual(
      [
        "tenant_id",
        "domain_status",
        "is_primary",
        "route_mode",
        "tenant_status",
        "tenant_code",
        "tenant_name",
        "default_locale"
      ].sort()
    );
    expect(columns).not.toContain("verification_token_hash");
    expect(columns).not.toContain("hostname");
    expect(columns).not.toContain("verification_record_value");
  });

  // ---------------------------------------------------------------------
  // Security fix (post-review): resolvePublicTenantByHost must complete in
  // exactly one DB round trip for every outcome, so an unknown host and a
  // host mapped to an active domain but an inactive tenant are not
  // distinguishable by response latency. Proven directly by counting query
  // invocations via a wrapping proxy around the same underlying sql client.
  // ---------------------------------------------------------------------

  test("resolvePublicTenantByHost issues exactly one query whether the host is unknown, mapped-but-inactive-tenant, or fully active", async () => {
    await insertDomain(TENANT_ACTIVE, "single-query-active.com");
    await insertDomain(TENANT_INACTIVE, "single-query-inactive-tenant.com");

    const baseSql = getTestSql();
    let callCount = 0;
    const countingSql = new Proxy(baseSql, {
      apply(target, thisArg, args) {
        callCount += 1;
        return Reflect.apply(
          target as unknown as (...a: unknown[]) => unknown,
          thisArg,
          args
        );
      }
    }) as unknown as Bun.SQL;

    callCount = 0;
    await resolvePublicTenantByHost(countingSql, "totally-unmapped-host.com");
    const unmappedCallCount = callCount;

    callCount = 0;
    await resolvePublicTenantByHost(
      countingSql,
      "single-query-inactive-tenant.com"
    );
    const inactiveTenantCallCount = callCount;

    callCount = 0;
    await resolvePublicTenantByHost(countingSql, "single-query-active.com");
    const activeCallCount = callCount;

    expect(unmappedCallCount).toBe(1);
    expect(inactiveTenantCallCount).toBe(1);
    expect(activeCallCount).toBe(1);
  });
});
