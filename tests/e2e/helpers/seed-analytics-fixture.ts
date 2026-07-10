/**
 * E2E-only fixture for the `/admin/analytics` raw-detail-gating spec
 * (Issue #622, epic: visitor analytics #617-#624). Extends
 * `seed-owner-tenant.ts`'s pattern (see that file's own comment for why
 * `POST /api/v1/setup/initialize` cannot be reused, and why this runs in a
 * separate `bun` subprocess rather than in-process alongside Playwright's
 * own browser IPC) to additionally seed a SECOND identity in the same
 * tenant, granted only `visitor_analytics.dashboard.read` and
 * `visitor_analytics.sessions.read` — deliberately NOT
 * `visitor_analytics.raw_detail.read` — so a real render can prove the
 * dashboard never shows that caller a raw IP hash/user-agent hash/login
 * identifier the owner's own session already produced.
 *
 * Connects with `DATABASE_URL` as-is (superuser role) — same convention
 * `seed-owner-tenant.ts` documents; seeding bypasses RLS on purpose, this
 * is fixture setup, not something under test.
 */
import { hashPassword } from "../../../src/lib/auth/password";

export type SeededAnalyticsFixture = {
  tenantId: string;
  owner: { loginIdentifier: string; password: string };
  restrictedViewer: { loginIdentifier: string; password: string };
};

export async function seedAnalyticsFixtureInProcess(
  databaseUrl: string,
  tenantCode: string
): Promise<SeededAnalyticsFixture> {
  const sql = new Bun.SQL(databaseUrl);
  const ownerLogin = `${tenantCode}-owner@example.com`;
  const ownerPassword = "e2e-analytics-owner-password";
  const viewerLogin = `${tenantCode}-viewer@example.com`;
  const viewerPassword = "e2e-analytics-viewer-password";

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

    // Owner — every permission, same shape as seed-owner-tenant.ts.
    const ownerProfileRows = await sql`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'E2E Owner')
      RETURNING id
    `;
    const ownerPasswordHash = await hashPassword(ownerPassword);
    const ownerIdentityRows = await sql`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${ownerProfileRows[0]!.id}, ${ownerLogin}, ${ownerPasswordHash})
      RETURNING id
    `;
    const ownerIdentityId = ownerIdentityRows[0]!.id as string;
    const ownerTenantUserRows = await sql`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${ownerIdentityId})
      RETURNING id
    `;
    const ownerTenantUserId = ownerTenantUserRows[0]!.id as string;
    const ownerRoleRows = await sql`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
      VALUES (${tenantId}, 'owner', 'Owner', true)
      RETURNING id
    `;
    const ownerRoleId = ownerRoleRows[0]!.id as string;
    await sql`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${tenantId}, ${ownerRoleId}, id FROM awcms_mini_permissions
    `;
    await sql`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
      VALUES (${tenantId}, ${ownerTenantUserId}, ${ownerRoleId}, ${ownerTenantUserId})
    `;

    // Restricted viewer — dashboard.read + sessions.read only, NOT raw_detail.read.
    const viewerProfileRows = await sql`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'E2E Restricted Viewer')
      RETURNING id
    `;
    const viewerPasswordHash = await hashPassword(viewerPassword);
    const viewerIdentityRows = await sql`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${viewerProfileRows[0]!.id}, ${viewerLogin}, ${viewerPasswordHash})
      RETURNING id
    `;
    const viewerIdentityId = viewerIdentityRows[0]!.id as string;
    const viewerTenantUserRows = await sql`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${viewerIdentityId})
      RETURNING id
    `;
    const viewerTenantUserId = viewerTenantUserRows[0]!.id as string;
    const viewerRoleRows = await sql`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
      VALUES (${tenantId}, 'analytics_view_only', 'Analytics Viewer', false)
      RETURNING id
    `;
    const viewerRoleId = viewerRoleRows[0]!.id as string;
    await sql`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${tenantId}, ${viewerRoleId}, p.id
      FROM awcms_mini_permissions p
      WHERE p.module_key = 'visitor_analytics'
        AND p.activity_code IN ('dashboard', 'realtime', 'sessions')
        AND p.action = 'read'
    `;
    await sql`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
      VALUES (${tenantId}, ${viewerTenantUserId}, ${viewerRoleId}, ${ownerTenantUserId})
    `;

    return {
      tenantId,
      owner: { loginIdentifier: ownerLogin, password: ownerPassword },
      restrictedViewer: {
        loginIdentifier: viewerLogin,
        password: viewerPassword
      }
    };
  } finally {
    await sql.end();
  }
}

export async function seedAnalyticsFixture(
  databaseUrl: string,
  tenantCode: string
): Promise<SeededAnalyticsFixture> {
  const cliPath = new URL("./seed-analytics-fixture-cli.ts", import.meta.url)
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
      `seed-analytics-fixture-cli.ts failed (exit ${exitCode}): ${stderr}`
    );
  }

  return JSON.parse(stdout.trim()) as SeededAnalyticsFixture;
}
