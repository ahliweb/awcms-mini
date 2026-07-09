/**
 * Integration tests for the Google OIDC foundation schema/RLS (Issue #590,
 * epic: full-online auth hardening) against a real PostgreSQL — migration
 * 035's two new tables. Same pattern `mfa-schema.integration.test.ts` (#589)
 * and `blog-content-schema.integration.test.ts` (#537) used: exercise
 * constraints and RLS enforcement directly via `withTenant`/raw admin SQL,
 * independent of the endpoint-level flow covered by
 * `google-oidc-flow.integration.test.ts`.
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
const PROFILE_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PROFILE_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const IDENTITY_A = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const IDENTITY_B = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const IDENTITY_A2 = "99999999-9999-9999-9999-999999999999";

async function seedFixtures(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
  await admin`
    INSERT INTO awcms_mini_profiles (id, tenant_id, profile_type, display_name)
    VALUES
      (${PROFILE_A}, ${TENANT_A}, 'person', 'Owner A'),
      (${PROFILE_B}, ${TENANT_B}, 'person', 'Owner B')
  `;
  await admin`
    INSERT INTO awcms_mini_identities
      (id, tenant_id, profile_id, login_identifier, password_hash)
    VALUES
      (${IDENTITY_A}, ${TENANT_A}, ${PROFILE_A}, 'owner-a@example.com', 'hash'),
      (${IDENTITY_A2}, ${TENANT_A}, ${PROFILE_A}, 'owner-a2@example.com', 'hash'),
      (${IDENTITY_B}, ${TENANT_B}, ${PROFILE_B}, 'owner-b@example.com', 'hash')
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Google OIDC schema — RLS isolation and constraints (Issue #590)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFixtures();
  });

  test("provider accounts: tenant A cannot see tenant B's linked account (RLS isolation)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_provider_accounts
        (tenant_id, identity_id, provider, provider_subject)
      VALUES
        (${TENANT_A}, ${IDENTITY_A}, 'google', 'subject-a'),
        (${TENANT_B}, ${IDENTITY_B}, 'google', 'subject-b')
    `;

    const sql = getDatabaseClient();
    const rows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT identity_id FROM awcms_mini_identity_provider_accounts`
    );

    expect(rows).toHaveLength(1);
    expect((rows as { identity_id: string }[])[0]?.identity_id).toBe(
      IDENTITY_A
    );
  });

  test("querying provider accounts without a tenant GUC set returns no rows (fail-closed)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_provider_accounts
        (tenant_id, identity_id, provider, provider_subject)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'google', 'subject-a')
    `;

    const sql = getDatabaseClient();
    const rows =
      await sql`SELECT identity_id FROM awcms_mini_identity_provider_accounts`;
    expect(rows).toHaveLength(0);
  });

  test("one identity can only link one account per provider (identity-scoped unique index)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_provider_accounts
        (tenant_id, identity_id, provider, provider_subject)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'google', 'subject-a')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_identity_provider_accounts
          (tenant_id, identity_id, provider, provider_subject)
        VALUES (${TENANT_A}, ${IDENTITY_A}, 'google', 'a-different-subject')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("one provider subject can only be linked to one identity (subject-scoped unique index)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_provider_accounts
        (tenant_id, identity_id, provider, provider_subject)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'google', 'shared-subject')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_identity_provider_accounts
          (tenant_id, identity_id, provider, provider_subject)
        VALUES (${TENANT_A}, ${IDENTITY_A2}, 'google', 'shared-subject')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("oidc auth requests: tenant A cannot see tenant B's request (RLS isolation)", async () => {
    const admin = getAdminSql();
    const future = new Date(Date.now() + 10 * 60_000);
    await admin`
      INSERT INTO awcms_mini_oidc_auth_requests
        (tenant_id, provider, state_hash, nonce, purpose, expires_at)
      VALUES
        (${TENANT_A}, 'google', 'sha256:aaa', 'nonce-a', 'login', ${future}),
        (${TENANT_B}, 'google', 'sha256:bbb', 'nonce-b', 'login', ${future})
    `;

    const sql = getDatabaseClient();
    const rows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT state_hash FROM awcms_mini_oidc_auth_requests`
    );

    expect(rows).toHaveLength(1);
    expect((rows as { state_hash: string }[])[0]?.state_hash).toBe(
      "sha256:aaa"
    );
  });

  test("oidc auth requests rejects an unknown purpose", async () => {
    const admin = getAdminSql();
    const future = new Date(Date.now() + 10 * 60_000);
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_oidc_auth_requests
          (tenant_id, provider, state_hash, nonce, purpose, expires_at)
        VALUES (${TENANT_A}, 'google', 'sha256:aaa', 'nonce-a', 'bogus', ${future})
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("oidc auth requests rejects a link-purpose row with no identity_id", async () => {
    const admin = getAdminSql();
    const future = new Date(Date.now() + 10 * 60_000);
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_oidc_auth_requests
          (tenant_id, provider, state_hash, nonce, purpose, identity_id, expires_at)
        VALUES (${TENANT_A}, 'google', 'sha256:aaa', 'nonce-a', 'link', NULL, ${future})
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("oidc auth requests accepts a link-purpose row WITH an identity_id", async () => {
    const admin = getAdminSql();
    const future = new Date(Date.now() + 10 * 60_000);

    const rows = await admin`
      INSERT INTO awcms_mini_oidc_auth_requests
        (tenant_id, provider, state_hash, nonce, purpose, identity_id, expires_at)
      VALUES (${TENANT_A}, 'google', 'sha256:aaa', 'nonce-a', 'link', ${IDENTITY_A}, ${future})
      RETURNING id
    `;

    expect(rows).toHaveLength(1);
  });
});
