/**
 * Integration tests for the email schema/RLS (Issue #494, epic #492)
 * against a real PostgreSQL. No endpoints exist yet (Issue #493 scoped
 * those out) — this exercises the migration's constraints and RLS
 * enforcement directly via `withTenant`, the same tenant-scoping helper
 * every real endpoint uses, rather than a reimplemented raw-SQL harness.
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

async function seedEmailMessage(tenantId: string, maskedAddress: string) {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_email_messages
      (tenant_id, category, to_address, to_address_hash, to_address_masked, subject)
    VALUES (
      ${tenantId}, 'auth.password_reset', 'user@example.com', 'sha256:fixture',
      ${maskedAddress}, 'Reset your password'
    )
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("email schema — RLS isolation", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  test("tenant A cannot see tenant B's email_messages row", async () => {
    await seedEmailMessage(TENANT_A, "a***@example.com");
    await seedEmailMessage(TENANT_B, "b***@example.com");

    const sql = getDatabaseClient();

    const tenantARows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT to_address_masked FROM awcms_mini_email_messages`
    );
    expect(tenantARows).toHaveLength(1);
    expect(
      (tenantARows as { to_address_masked: string }[])[0]?.to_address_masked
    ).toBe("a***@example.com");

    const tenantBRows = await withTenant(
      sql,
      TENANT_B,
      (tx) => tx`SELECT to_address_masked FROM awcms_mini_email_messages`
    );
    expect(tenantBRows).toHaveLength(1);
    expect(
      (tenantBRows as { to_address_masked: string }[])[0]?.to_address_masked
    ).toBe("b***@example.com");
  });

  test("querying without a tenant GUC set returns no rows (fail-closed)", async () => {
    await seedEmailMessage(TENANT_A, "a***@example.com");

    const sql = getDatabaseClient();
    const rows =
      await sql`SELECT to_address_masked FROM awcms_mini_email_messages`;

    expect(rows).toHaveLength(0);
  });

  test("dispatcher polling index query only returns the calling tenant's queued rows", async () => {
    await seedEmailMessage(TENANT_A, "a***@example.com");
    await seedEmailMessage(TENANT_B, "b***@example.com");

    const sql = getDatabaseClient();
    const rows = await withTenant(
      sql,
      TENANT_A,
      (tx) =>
        tx`
        SELECT to_address_masked FROM awcms_mini_email_messages
        WHERE status = 'queued'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
      `
    );

    expect(rows).toHaveLength(1);
    expect(
      (rows as { to_address_masked: string }[])[0]?.to_address_masked
    ).toBe("a***@example.com");
  });

  test("email_templates rejects an invalid template_key format", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_email_templates
          (tenant_id, template_key, name, subject_template, text_body_template, created_by, updated_by)
        VALUES (
          ${TENANT_A}, 'BadKey', 'Bad', ${{ en: "Subject" }}, ${{ en: "Body" }},
          gen_random_uuid(), gen_random_uuid()
        )
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("email_templates allows re-using a template_key after soft delete", async () => {
    const admin = getAdminSql();

    await admin`
      INSERT INTO awcms_mini_email_templates
        (tenant_id, template_key, name, subject_template, text_body_template, created_by, updated_by)
      VALUES (
        ${TENANT_A}, 'auth.password_reset', 'v1', ${{ en: "Subject" }}, ${{ en: "Body" }},
        gen_random_uuid(), gen_random_uuid()
      )
    `;

    await admin`
      UPDATE awcms_mini_email_templates
      SET deleted_at = now(), deleted_by = gen_random_uuid(), delete_reason = 'superseded'
      WHERE tenant_id = ${TENANT_A} AND template_key = 'auth.password_reset'
    `;

    const rows = await admin`
      INSERT INTO awcms_mini_email_templates
        (tenant_id, template_key, name, subject_template, text_body_template, created_by, updated_by)
      VALUES (
        ${TENANT_A}, 'auth.password_reset', 'v2', ${{ en: "Subject" }}, ${{ en: "Body" }},
        gen_random_uuid(), gen_random_uuid()
      )
      RETURNING id
    `;

    expect(rows).toHaveLength(1);
  });

  test("email permission catalog is seeded", async () => {
    const admin = getAdminSql();
    const rows = (await admin`
      SELECT activity_code, action FROM awcms_mini_permissions
      WHERE module_key = 'email'
      ORDER BY activity_code, action
    `) as { activity_code: string; action: string }[];

    expect(rows.map((row) => `${row.activity_code}.${row.action}`)).toEqual([
      "announcement.create",
      "message.cancel",
      "message.read",
      "notification.create",
      "suppression.create",
      "suppression.delete",
      "suppression.read",
      "template.create",
      "template.delete",
      "template.read",
      "template.restore",
      "template.update"
    ]);
  });
});
