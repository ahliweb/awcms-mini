/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue
 * #622 testing checklist item "access denied" (epic: visitor analytics
 * #617-#624).
 *
 * `/admin/analytics`'s own frontmatter checks
 * `visitor_analytics.dashboard.read` server-side before rendering
 * anything else (`src/pages/admin/analytics.astro`) — this spec proves
 * that branch renders ONLY the access-denied `StateNotice` and that the
 * dashboard markup (`.analytics-dashboard`) never reaches the DOM at all
 * for a caller with zero role/permission assignment, the same "prove the
 * server branch, not just hide it with CSS" reasoning
 * `admin-security-disabled.e2e.ts` documents for its own analogous case.
 *
 * Logs in through the real `/login` form rather than
 * `page.request.post(...)` — see `admin-security-disabled.e2e.ts`'s own
 * header comment for the intermittent Playwright/Bun IPC breakage a
 * cookie-setting `page.request` call can trigger in this environment.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role.
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database.
 *
 * Run: `bun run test:e2e tests/e2e/admin-analytics-access-denied.e2e.ts`.
 */
import { test, expect } from "@playwright/test";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

const NOROLE_LOGIN = "norole@example.com";
const NOROLE_PASSWORD = "e2e-analytics-norole-password";

test.describe("admin/analytics — access denied", () => {
  test("a tenant user with no role/permission assignment sees the access-denied state, never the dashboard", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-an-denied-${crypto.randomUUID().slice(0, 8)}`
    );

    // Create a second identity in the same tenant with a `tenant_users`
    // membership but zero role assignments — the same default-deny
    // fixture shape `admin-security-ui.integration.test.ts`'s own
    // `bootstrapNoRoleUser` uses, done here directly via the superuser
    // connection (no in-process Bun.SQL call shares an event loop with
    // Playwright's own browser IPC — see `seed-owner-tenant-cli.ts`'s own
    // comment for why that matters).
    const sql = new Bun.SQL(seedDatabaseUrl!);
    try {
      const profileRows = await sql`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${owner.tenantId}, 'person', 'No Role User')
        RETURNING id
      `;
      const passwordHash = await Bun.password.hash(NOROLE_PASSWORD);
      const identityRows = await sql`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${owner.tenantId}, ${profileRows[0]!.id}, ${NOROLE_LOGIN}, ${passwordHash})
        RETURNING id
      `;
      await sql`
        INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
        VALUES (${owner.tenantId}, ${identityRows[0]!.id})
      `;
    } finally {
      await sql.end();
    }

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(NOROLE_LOGIN);
    await page.locator("#password").fill(NOROLE_PASSWORD);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/analytics");

    const deniedNotice = page.locator('.state-notice[data-kind="denied"]');
    await expect(deniedNotice).toBeVisible();

    // The dashboard markup must not exist in the DOM at all — proving the
    // server-side branch, not merely a CSS-hidden block a client script
    // could still read data into.
    await expect(page.locator(".analytics-dashboard")).toHaveCount(0);
    await expect(page.locator("[data-section]")).toHaveCount(0);

    // No error message ever leaks internal detail (doc 10 guardrail).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toContain("stack");
    expect(bodyText.toLowerCase()).not.toContain("postgres");
  });
});
