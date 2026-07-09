/**
 * Integration tests for the MFA/TOTP foundation schema/RLS (Issue #589,
 * epic: full-online auth hardening) against a real PostgreSQL — migration
 * 034's three new tables. Same pattern `blog-content-schema.integration.test.ts`
 * (#537) and `module-management-schema.integration.test.ts` (#512) used:
 * exercise constraints and RLS enforcement directly via `withTenant`/raw
 * admin SQL, independent of the endpoint-level flow covered by
 * `mfa-flow.integration.test.ts`.
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
      (${IDENTITY_B}, ${TENANT_B}, ${PROFILE_B}, 'owner-b@example.com', 'hash')
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("MFA/TOTP schema — RLS isolation and constraints (Issue #589)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFixtures();
  });

  test("tenant A cannot see tenant B's MFA factor (RLS isolation)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_mfa_factors
        (tenant_id, identity_id, factor_type, secret_ciphertext, status)
      VALUES
        (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:a:b:c', 'active'),
        (${TENANT_B}, ${IDENTITY_B}, 'totp', 'v1:d:e:f', 'active')
    `;

    const sql = getDatabaseClient();
    const rows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT identity_id FROM awcms_mini_identity_mfa_factors`
    );

    expect(rows).toHaveLength(1);
    expect((rows as { identity_id: string }[])[0]?.identity_id).toBe(
      IDENTITY_A
    );
  });

  test("querying factors without a tenant GUC set returns no rows (fail-closed)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_mfa_factors
        (tenant_id, identity_id, factor_type, secret_ciphertext, status)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:a:b:c', 'active')
    `;

    const sql = getDatabaseClient();
    const rows =
      await sql`SELECT identity_id FROM awcms_mini_identity_mfa_factors`;
    expect(rows).toHaveLength(0);
  });

  test("only one non-disabled factor per identity is allowed (partial unique index)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_identity_mfa_factors
        (tenant_id, identity_id, factor_type, secret_ciphertext, status)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:a:b:c', 'pending')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_identity_mfa_factors
          (tenant_id, identity_id, factor_type, secret_ciphertext, status)
        VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:x:y:z', 'active')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);

    // A disabled factor doesn't count toward the constraint — a fresh
    // pending/active factor can coexist with a prior disabled one.
    await admin`
      UPDATE awcms_mini_identity_mfa_factors
      SET status = 'disabled'
      WHERE tenant_id = ${TENANT_A} AND identity_id = ${IDENTITY_A}
    `;
    let secondDidThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_identity_mfa_factors
          (tenant_id, identity_id, factor_type, secret_ciphertext, status)
        VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:x:y:z', 'active')
      `;
    } catch {
      secondDidThrow = true;
    }
    expect(secondDidThrow).toBe(false);
  });

  test("factors rejects an unknown status", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_identity_mfa_factors
          (tenant_id, identity_id, factor_type, secret_ciphertext, status)
        VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:a:b:c', 'bogus')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("recovery codes: tenant A cannot see tenant B's codes (RLS isolation)", async () => {
    const admin = getAdminSql();
    const [factorA] = (await admin`
      INSERT INTO awcms_mini_identity_mfa_factors
        (tenant_id, identity_id, factor_type, secret_ciphertext, status)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:a:b:c', 'active')
      RETURNING id
    `) as { id: string }[];
    const [factorB] = (await admin`
      INSERT INTO awcms_mini_identity_mfa_factors
        (tenant_id, identity_id, factor_type, secret_ciphertext, status)
      VALUES (${TENANT_B}, ${IDENTITY_B}, 'totp', 'v1:d:e:f', 'active')
      RETURNING id
    `) as { id: string }[];

    await admin`
      INSERT INTO awcms_mini_identity_mfa_recovery_codes
        (tenant_id, identity_id, factor_id, code_hash)
      VALUES
        (${TENANT_A}, ${IDENTITY_A}, ${factorA!.id}, 'sha256:aaa'),
        (${TENANT_B}, ${IDENTITY_B}, ${factorB!.id}, 'sha256:bbb')
    `;

    const sql = getDatabaseClient();
    const rows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT code_hash FROM awcms_mini_identity_mfa_recovery_codes`
    );

    expect(rows).toHaveLength(1);
    expect((rows as { code_hash: string }[])[0]?.code_hash).toBe("sha256:aaa");
  });

  test("recovery codes are deleted when their factor is deleted (ON DELETE CASCADE)", async () => {
    const admin = getAdminSql();
    const [factorA] = (await admin`
      INSERT INTO awcms_mini_identity_mfa_factors
        (tenant_id, identity_id, factor_type, secret_ciphertext, status)
      VALUES (${TENANT_A}, ${IDENTITY_A}, 'totp', 'v1:a:b:c', 'active')
      RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_mini_identity_mfa_recovery_codes
        (tenant_id, identity_id, factor_id, code_hash)
      VALUES (${TENANT_A}, ${IDENTITY_A}, ${factorA!.id}, 'sha256:aaa')
    `;

    await admin`DELETE FROM awcms_mini_identity_mfa_factors WHERE id = ${factorA!.id}`;

    const remaining = await admin`
      SELECT id FROM awcms_mini_identity_mfa_recovery_codes WHERE factor_id = ${factorA!.id}
    `;
    expect(remaining).toHaveLength(0);
  });

  test("challenges: tenant A cannot see tenant B's challenge (RLS isolation)", async () => {
    const admin = getAdminSql();
    const future = new Date(Date.now() + 5 * 60_000);
    await admin`
      INSERT INTO awcms_mini_mfa_challenges
        (tenant_id, identity_id, challenge_token_hash, expires_at)
      VALUES
        (${TENANT_A}, ${IDENTITY_A}, 'sha256:aaa', ${future}),
        (${TENANT_B}, ${IDENTITY_B}, 'sha256:bbb', ${future})
    `;

    const sql = getDatabaseClient();
    const rows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT challenge_token_hash FROM awcms_mini_mfa_challenges`
    );

    expect(rows).toHaveLength(1);
    expect(
      (rows as { challenge_token_hash: string }[])[0]?.challenge_token_hash
    ).toBe("sha256:aaa");
  });

  test("challenges rejects a negative failed_attempts", async () => {
    const admin = getAdminSql();
    const future = new Date(Date.now() + 5 * 60_000);
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_mfa_challenges
          (tenant_id, identity_id, challenge_token_hash, expires_at, failed_attempts)
        VALUES (${TENANT_A}, ${IDENTITY_A}, 'sha256:aaa', ${future}, -1)
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });
});
