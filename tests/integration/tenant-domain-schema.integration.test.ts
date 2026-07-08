/**
 * Integration tests for the tenant domain schema/RLS (Issue #557, epic
 * #555) against a real PostgreSQL. Schema-only issue — no module
 * descriptor (#558), resolver (#559), or API (#562) exist yet — this
 * exercises migration 031/032's constraints and RLS enforcement directly
 * via `withTenant`/raw admin SQL, the same pattern
 * `blog-content-schema.integration.test.ts` (#537) and
 * `module-management-schema.integration.test.ts` (#512) used.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";

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

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant_domain schema — RLS isolation and constraints", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  test("db:migrate is idempotent when run twice", async () => {
    // applyMigrations() shells out to the real `scripts/db-migrate.ts`
    // runner (same one `bun run db:migrate` invokes). beforeAll already ran
    // it once; running it again here must not throw and must leave the
    // schema/permission seed intact.
    await expect(applyMigrations()).resolves.toBeUndefined();

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT activity_code, action FROM awcms_mini_permissions
      WHERE module_key = 'tenant_domain'
      ORDER BY activity_code, action
    `) as { activity_code: string; action: string }[];

    expect(rows.map((row) => `${row.activity_code}.${row.action}`)).toEqual([
      "domains.create",
      "domains.delete",
      "domains.read",
      "domains.set_primary",
      "domains.update",
      "domains.verify"
    ]);
  });

  test("tenant_domain permission catalog is seeded with exactly the issue's six permissions", async () => {
    const admin = getAdminSql();
    const rows = (await admin`
      SELECT activity_code, action FROM awcms_mini_permissions
      WHERE module_key = 'tenant_domain'
      ORDER BY activity_code, action
    `) as { activity_code: string; action: string }[];

    expect(rows.map((row) => `${row.activity_code}.${row.action}`)).toEqual([
      "domains.create",
      "domains.delete",
      "domains.read",
      "domains.set_primary",
      "domains.update",
      "domains.verify"
    ]);
  });

  test("rejects an unknown status", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_tenant_domains
          (tenant_id, hostname, normalized_hostname, status)
        VALUES (${TENANT_A}, 'example.com', 'example.com', 'bogus')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("rejects a normalized_hostname that does not match lower(trim(hostname))", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_tenant_domains
          (tenant_id, hostname, normalized_hostname)
        VALUES (${TENANT_A}, 'Example.com', 'not-normalized.com')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("normalized_hostname is unique (case-insensitive) among active rows", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname)
      VALUES (${TENANT_A}, 'Example.com', 'example.com')
    `;

    let didThrow = false;
    try {
      // Same hostname, different casing/whitespace — normalizes to the same
      // value, so this must collide on the tenant B side too.
      await admin`
        INSERT INTO awcms_mini_tenant_domains
          (tenant_id, hostname, normalized_hostname)
        VALUES (${TENANT_B}, ' EXAMPLE.com ', 'example.com')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("soft-deleting a domain frees its normalized_hostname for reuse", async () => {
    const admin = getAdminSql();
    const firstRows = await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname)
      VALUES (${TENANT_A}, 'example.com', 'example.com')
      RETURNING id
    `;
    const firstId = (firstRows as { id: string }[])[0]!.id;

    await admin`
      UPDATE awcms_mini_tenant_domains
      SET deleted_at = now(), delete_reason = 'moved off platform'
      WHERE id = ${firstId}
    `;

    const secondRows = await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname)
      VALUES (${TENANT_B}, 'example.com', 'example.com')
      RETURNING id
    `;

    expect(secondRows).toHaveLength(1);
  });

  test("only one active primary domain can exist per tenant", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, is_primary)
      VALUES (${TENANT_A}, 'primary-one.com', 'primary-one.com', true)
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_tenant_domains
          (tenant_id, hostname, normalized_hostname, is_primary)
        VALUES (${TENANT_A}, 'primary-two.com', 'primary-two.com', true)
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);

    // A second tenant can independently have its own primary domain.
    const otherTenantRows = await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, is_primary)
      VALUES (${TENANT_B}, 'b-primary.com', 'b-primary.com', true)
      RETURNING id
    `;
    expect(otherTenantRows).toHaveLength(1);
  });

  test("a soft-deleted primary domain does not block a new primary for the same tenant", async () => {
    const admin = getAdminSql();
    const firstRows = await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, is_primary)
      VALUES (${TENANT_A}, 'old-primary.com', 'old-primary.com', true)
      RETURNING id
    `;
    const firstId = (firstRows as { id: string }[])[0]!.id;

    await admin`
      UPDATE awcms_mini_tenant_domains
      SET deleted_at = now(), delete_reason = 'domain retired', is_primary = false
      WHERE id = ${firstId}
    `;

    const secondRows = await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, is_primary)
      VALUES (${TENANT_A}, 'new-primary.com', 'new-primary.com', true)
      RETURNING id
    `;

    expect(secondRows).toHaveLength(1);
  });

  test("tenant A cannot see tenant B's domains (RLS isolation)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname)
      VALUES
        (${TENANT_A}, 'a-domain.com', 'a-domain.com'),
        (${TENANT_B}, 'b-domain.com', 'b-domain.com')
    `;

    const sql = getDatabaseClient();
    const tenantARows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT normalized_hostname FROM awcms_mini_tenant_domains`
    );

    expect(tenantARows).toHaveLength(1);
    expect(
      (tenantARows as { normalized_hostname: string }[])[0]?.normalized_hostname
    ).toBe("a-domain.com");
  });

  test("querying domains without a tenant GUC set returns no rows (fail-closed)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname)
      VALUES (${TENANT_A}, 'a-domain.com', 'a-domain.com')
    `;

    const sql = getDatabaseClient();
    const rows =
      await sql`SELECT normalized_hostname FROM awcms_mini_tenant_domains`;

    expect(rows).toHaveLength(0);
  });

  test("no DNS provider secret column exists on the table", async () => {
    const admin = getAdminSql();
    const columns = (await admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'awcms_mini_tenant_domains'
    `) as { column_name: string }[];

    const columnNames = columns.map((row) => row.column_name);

    for (const forbidden of [
      "provider_token",
      "provider_secret",
      "api_key",
      "api_token",
      "dns_provider_token",
      "verification_token"
    ]) {
      expect(columnNames).not.toContain(forbidden);
    }

    // Only the hashed form is present, never a raw token column.
    expect(columnNames).toContain("verification_token_hash");
  });
});
