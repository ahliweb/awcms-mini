/**
 * E2E-only tenant/owner seeding helper (Issue #592). `POST
 * /api/v1/setup/initialize` cannot be reused here: it is a once-only,
 * singleton-locked endpoint (`awcms_mini_setup_state`, see that route's own
 * comment) that has almost certainly already been claimed on any long-lived
 * dev database — exactly the situation memory `manual-admin-ui-smoke-test`
 * documents for the curl-based recipe this helper adapts for Playwright.
 * Mirrors that endpoint's own insert order/columns
 * (`src/pages/api/v1/setup/initialize.ts`) via a direct, privileged
 * (superuser) `Bun.SQL` connection instead, so any number of isolated E2E
 * tenants can be created regardless of that lock's state — every tenant
 * code passed in must be unique per test run.
 *
 * Connects with `DATABASE_URL` as-is: E2E specs are expected to export the
 * PRIVILEGED (superuser) role for this helper specifically (same
 * "DATABASE_URL is the superuser role" convention
 * `tests/integration/harness.ts` documents for `getAdminSql()`) — seeding
 * bypasses RLS entirely, which is fine here since this is fixture setup,
 * not something under test. The dev server under test connects with its
 * OWN, separate `DATABASE_URL` (the least-privilege `awcms_mini_app` role,
 * same as production) in its own process/environment — this file has no
 * relationship to that connection.
 *
 * `seedOwnerTenant` (the export every spec file actually calls) runs
 * `seedOwnerTenantInProcess` below in a SEPARATE `bun` subprocess via
 * `seed-owner-tenant-cli.ts` — see that file's own comment for why calling
 * `Bun.password.hash` + several `Bun.SQL` queries directly inside the same
 * process that drives Playwright's browser intermittently breaks
 * Playwright's own IPC channel to Chromium. Never call
 * `seedOwnerTenantInProcess` directly from a `*.e2e.ts` spec file.
 */
import { hashPassword } from "../../../src/lib/auth/password";

export type SeededOwner = {
  tenantId: string;
  loginIdentifier: string;
  password: string;
};

export async function seedOwnerTenant(
  databaseUrl: string,
  tenantCode: string
): Promise<SeededOwner> {
  const cliPath = new URL("./seed-owner-tenant-cli.ts", import.meta.url)
    .pathname;
  const proc = Bun.spawn(["bun", cliPath, databaseUrl, tenantCode], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `seed-owner-tenant-cli.ts failed (exit ${exitCode}): ${stderr}`
    );
  }

  return JSON.parse(stdout.trim()) as SeededOwner;
}

export async function seedOwnerTenantInProcess(
  databaseUrl: string,
  tenantCode: string
): Promise<SeededOwner> {
  const sql = new Bun.SQL(databaseUrl);
  const loginIdentifier = `${tenantCode}-owner@example.com`;
  const password = "e2e-security-owner-password";

  try {
    const tenantRows = await sql`
      INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
      VALUES (${tenantCode}, ${`E2E ${tenantCode}`})
      RETURNING id
    `;
    const tenantId = tenantRows[0]!.id as string;

    await sql`
      INSERT INTO awcms_mini_tenant_settings (tenant_id) VALUES (${tenantId})
    `;

    await sql`
      INSERT INTO awcms_mini_offices (tenant_id, office_code, office_name, office_type)
      VALUES (${tenantId}, 'hq', 'Head Office', 'head_office')
    `;

    const profileRows = await sql`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'E2E Owner')
      RETURNING id
    `;
    const profileId = profileRows[0]!.id as string;

    const passwordHash = await hashPassword(password);
    const identityRows = await sql`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profileId}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `;
    const identityId = identityRows[0]!.id as string;

    const tenantUserRows = await sql`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identityId})
      RETURNING id
    `;
    const tenantUserId = tenantUserRows[0]!.id as string;

    const roleRows = await sql`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
      VALUES (${tenantId}, 'owner', 'Owner', true)
      RETURNING id
    `;
    const roleId = roleRows[0]!.id as string;

    await sql`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${tenantId}, ${roleId}, id FROM awcms_mini_permissions
    `;

    await sql`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
      VALUES (${tenantId}, ${tenantUserId}, ${roleId}, ${tenantUserId})
    `;

    return { tenantId, loginIdentifier, password };
  } finally {
    await sql.end();
  }
}
