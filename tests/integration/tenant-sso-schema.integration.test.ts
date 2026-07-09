/**
 * Integration tests for the generic tenant OIDC SSO schema/RLS (Issue #591,
 * epic: full-online auth hardening) against a real PostgreSQL — migration
 * 036's two new tables (`awcms_mini_auth_providers`,
 * `awcms_mini_tenant_auth_policies`). Same pattern as
 * `google-oidc-schema.integration.test.ts` (#590): exercise constraints and
 * RLS enforcement directly via `withTenant`/raw admin SQL, independent of
 * the endpoint-level flow covered by `tenant-sso-flow.integration.test.ts`.
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

suite(
  "Tenant OIDC SSO schema — RLS isolation and constraints (Issue #591)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
      await seedTenants();
    });

    test("auth providers: tenant A cannot see tenant B's provider (RLS isolation)", async () => {
      const admin = getAdminSql();
      await admin`
      INSERT INTO awcms_mini_auth_providers
        (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
      VALUES
        (${TENANT_A}, 'okta', 'Okta A', 'https://a.okta.com', 'client-a', 'A_SECRET'),
        (${TENANT_B}, 'okta', 'Okta B', 'https://b.okta.com', 'client-b', 'B_SECRET')
    `;

      const sql = getDatabaseClient();
      const rows = await withTenant(
        sql,
        TENANT_A,
        (tx) => tx`SELECT provider_key FROM awcms_mini_auth_providers`
      );

      expect(rows).toHaveLength(1);
      expect((rows as { provider_key: string }[])[0]?.provider_key).toBe(
        "okta"
      );
    });

    test("querying auth providers without a tenant GUC set returns no rows (fail-closed)", async () => {
      const admin = getAdminSql();
      await admin`
      INSERT INTO awcms_mini_auth_providers
        (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
      VALUES (${TENANT_A}, 'okta', 'Okta A', 'https://a.okta.com', 'client-a', 'A_SECRET')
    `;

      const sql = getDatabaseClient();
      const rows =
        await sql`SELECT provider_key FROM awcms_mini_auth_providers`;
      expect(rows).toHaveLength(0);
    });

    test("provider_key is unique per tenant among non-deleted providers", async () => {
      const admin = getAdminSql();
      await admin`
      INSERT INTO awcms_mini_auth_providers
        (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
      VALUES (${TENANT_A}, 'okta', 'Okta A', 'https://a.okta.com', 'client-a', 'A_SECRET')
    `;

      let didThrow = false;
      try {
        await admin`
        INSERT INTO awcms_mini_auth_providers
          (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
        VALUES (${TENANT_A}, 'okta', 'Okta A (dup)', 'https://a2.okta.com', 'client-a2', 'A2_SECRET')
      `;
      } catch {
        didThrow = true;
      }

      expect(didThrow).toBe(true);
    });

    test("a soft-deleted provider's key can be reused", async () => {
      const admin = getAdminSql();
      const rows = await admin`
      INSERT INTO awcms_mini_auth_providers
        (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
      VALUES (${TENANT_A}, 'okta', 'Okta A', 'https://a.okta.com', 'client-a', 'A_SECRET')
      RETURNING id
    `;
      const providerId = (rows[0] as { id: string }).id;

      await admin`
      UPDATE awcms_mini_auth_providers
      SET deleted_at = now(), deleted_by = NULL, delete_reason = 'test'
      WHERE id = ${providerId}
    `;

      const reinsert = await admin`
      INSERT INTO awcms_mini_auth_providers
        (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
      VALUES (${TENANT_A}, 'okta', 'Okta A (new)', 'https://a-new.okta.com', 'client-a-new', 'A_NEW_SECRET')
      RETURNING id
    `;

      expect(reinsert).toHaveLength(1);
    });

    test("rejects a provider with BOTH client_secret_ciphertext and client_secret_env_var set", async () => {
      const admin = getAdminSql();
      let didThrow = false;

      try {
        await admin`
        INSERT INTO awcms_mini_auth_providers
          (tenant_id, provider_key, display_name, issuer_url, client_id,
           client_secret_ciphertext, client_secret_env_var)
        VALUES (${TENANT_A}, 'okta', 'Okta A', 'https://a.okta.com', 'client-a', 'v1:a:b:c', 'A_SECRET')
      `;
      } catch {
        didThrow = true;
      }

      expect(didThrow).toBe(true);
    });

    test("rejects a provider with NEITHER client_secret_ciphertext nor client_secret_env_var set", async () => {
      const admin = getAdminSql();
      let didThrow = false;

      try {
        await admin`
        INSERT INTO awcms_mini_auth_providers
          (tenant_id, provider_key, display_name, issuer_url, client_id)
        VALUES (${TENANT_A}, 'okta', 'Okta A', 'https://a.okta.com', 'client-a')
      `;
      } catch {
        didThrow = true;
      }

      expect(didThrow).toBe(true);
    });

    test("rejects an invalid provider_key format", async () => {
      const admin = getAdminSql();
      let didThrow = false;

      try {
        await admin`
        INSERT INTO awcms_mini_auth_providers
          (tenant_id, provider_key, display_name, issuer_url, client_id, client_secret_env_var)
        VALUES (${TENANT_A}, 'Not Valid!', 'Bad', 'https://a.okta.com', 'client-a', 'A_SECRET')
      `;
      } catch {
        didThrow = true;
      }

      expect(didThrow).toBe(true);
    });

    test("tenant auth policies: tenant A cannot see tenant B's policy (RLS isolation)", async () => {
      const admin = getAdminSql();
      await admin`
      INSERT INTO awcms_mini_tenant_auth_policies (tenant_id, sso_required)
      VALUES (${TENANT_A}, false), (${TENANT_B}, false)
    `;

      const sql = getDatabaseClient();
      const rows = await withTenant(
        sql,
        TENANT_A,
        (tx) => tx`SELECT tenant_id FROM awcms_mini_tenant_auth_policies`
      );

      expect(rows).toHaveLength(1);
      expect((rows as { tenant_id: string }[])[0]?.tenant_id).toBe(TENANT_A);
    });

    test("only one auth policy row per tenant (unique index)", async () => {
      const admin = getAdminSql();
      await admin`
      INSERT INTO awcms_mini_tenant_auth_policies (tenant_id) VALUES (${TENANT_A})
    `;

      let didThrow = false;
      try {
        await admin`
        INSERT INTO awcms_mini_tenant_auth_policies (tenant_id) VALUES (${TENANT_A})
      `;
      } catch {
        didThrow = true;
      }

      expect(didThrow).toBe(true);
    });

    test("rejects a policy with BOTH password_login_enabled and sso_enabled false", async () => {
      const admin = getAdminSql();
      let didThrow = false;

      try {
        await admin`
        INSERT INTO awcms_mini_tenant_auth_policies
          (tenant_id, password_login_enabled, sso_enabled)
        VALUES (${TENANT_A}, false, false)
      `;
      } catch {
        didThrow = true;
      }

      expect(didThrow).toBe(true);
    });

    test("identity_provider_accounts (migration 035) accepts a non-google provider value — reused generically by #591", async () => {
      const admin = getAdminSql();
      const profileRows = await admin`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${TENANT_A}, 'person', 'Owner A')
      RETURNING id
    `;
      const identityRows = await admin`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${TENANT_A}, ${(profileRows[0] as { id: string }).id}, 'owner-a@example.com', 'hash')
      RETURNING id
    `;

      const rows = await admin`
      INSERT INTO awcms_mini_identity_provider_accounts
        (tenant_id, identity_id, provider, provider_subject)
      VALUES (${TENANT_A}, ${(identityRows[0] as { id: string }).id}, 'okta', 'okta-subject-1')
      RETURNING id
    `;

      expect(rows).toHaveLength(1);
    });
  }
);
