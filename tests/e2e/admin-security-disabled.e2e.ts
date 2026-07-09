/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue #592
 * testing checklist item "UI test: offline/local informational state only".
 *
 * Targets `/admin/security` with the dev server running WITHOUT
 * `AUTH_ONLINE_SECURITY_ENABLED`/`AUTH_ONLINE_SECURITY_PROFILE` set (the
 * default for every local/offline/LAN deployment) — the issue's own
 * acceptance criterion: "On local/offline/LAN or when #587 gate is
 * disabled, UI shows informational status only... Full configuration
 * controls are rendered only when #587 gate is enabled." This is a
 * server-side branch (`src/pages/admin/security.astro`'s own frontmatter
 * checks `isFullOnlineSecurityActive` before rendering anything else), so
 * this spec asserts the policy/provider forms are entirely ABSENT from the
 * rendered DOM — not merely hidden by CSS — which only a real render can
 * prove.
 *
 * Logs in through the real `/login` form (fill + submit + wait for the
 * `/admin` redirect), NOT `page.request.post("/api/v1/auth/login")` —
 * empirically, a SUCCESSFUL login's `Set-Cookie` response headers going
 * through Playwright's `page.request` API (as opposed to a real navigation/
 * form submit) intermittently broke every subsequent `page.request`/
 * `page.goto` call in this environment with an unrelated-looking
 * `TypeError: "<path>" cannot be parsed as a URL.` (isolated by bisection
 * during this issue's own implementation — reproduces even with a fully
 * qualified absolute URL, only after a 200 response carrying `Set-Cookie`;
 * a failed login attempt, or the same request with no cookie-setting
 * response, never reproduces it). Driving the real login form sidesteps
 * the whole class of that bug AND is arguably the more faithful "browser
 * E2E" exercise per this skill's own purpose anyway.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role,
 *     used once to seed an isolated owner/tenant fixture directly (see
 *     `helpers/seed-owner-tenant.ts` for why `POST /setup/initialize`
 *     itself cannot be reused for this).
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database, with
 *     `AUTH_ONLINE_SECURITY_ENABLED` unset/not `"true"`.
 *
 * Run: `bun run test:e2e tests/e2e/admin-security-disabled.e2e.ts` — see
 * this repo's own skill doc for the full dev-server/DB setup this assumes.
 */
import { test, expect } from "@playwright/test";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

test.describe("admin/security — full-online gate disabled", () => {
  test("renders only the informational notice, no policy/provider forms", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-sec-off-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/security");

    const infoNotice = page.locator('.state-notice[data-kind="info"]');
    await expect(infoNotice).toBeVisible();
    await expect(infoNotice).toHaveAttribute("role", "status");

    // The full configuration controls must not exist in the DOM at all —
    // proving the server-side branch, not just a CSS `display: none`.
    await expect(page.locator("#policy-form")).toHaveCount(0);
    await expect(page.locator("#create-provider-form")).toHaveCount(0);
    await expect(page.locator('.state-notice[data-kind="denied"]')).toHaveCount(
      0
    );
  });
});
