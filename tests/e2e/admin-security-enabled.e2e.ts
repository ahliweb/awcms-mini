/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue #592
 * testing checklist item "UI test: full-online policy form visible when
 * gate enabled".
 *
 * Targets `/admin/security` with the dev server running WITH
 * `AUTH_ONLINE_SECURITY_ENABLED=true`/`AUTH_ONLINE_SECURITY_PROFILE=full_online`
 * — the issue's own acceptance criterion: "Full configuration controls are
 * rendered only when #587 gate is enabled." The seeded owner has every
 * permission (mirrors `POST /setup/initialize`'s own owner role — see
 * `helpers/seed-owner-tenant.ts`), so both the tenant auth policy form and
 * the SSO provider create form must render.
 *
 * Logs in through the real `/login` form — see
 * `admin-security-disabled.e2e.ts`'s own header comment for why
 * `page.request.post("/api/v1/auth/login")` is deliberately NOT used here.
 *
 * Deliberately does NOT submit either form or exercise the break-glass
 * rejection here — the orchestrating issue's own instructions route that
 * coverage to `tests/integration/admin-security-ui.integration.test.ts`
 * (ABAC 403 + audit rows) and Issue #591's own
 * `tenant-sso-flow.integration.test.ts` (break-glass 409), both far
 * cheaper than a browser for asserting API status codes/DB rows. This spec
 * only proves the two forms exist and are usable in a real render.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — see `admin-security-disabled.e2e.ts`'s own
 *     header comment.
 *   - The dev server under `E2E_BASE_URL` must be running against the SAME
 *     database, with `AUTH_ONLINE_SECURITY_ENABLED=true` and
 *     `AUTH_ONLINE_SECURITY_PROFILE=full_online`.
 *
 * Run: `bun run test:e2e tests/e2e/admin-security-enabled.e2e.ts`.
 */
import { test, expect } from "@playwright/test";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

// Tagged `@full-online-gate` (Issue #685) — ci.yml's `e2e-smoke` job
// selects/excludes this spec by that stable tag, not by matching this
// title's prose, so renaming the title alone can't silently desync CI's
// two-phase server-lifecycle selector. See .github/workflows/ci.yml.
test.describe("admin/security — full-online gate enabled @full-online-gate", () => {
  test("renders the status summary plus policy and create-provider forms", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-sec-on-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/security");

    // No informational-only or access-denied branch — the full page.
    await expect(page.locator('.state-notice[data-kind="info"]')).toHaveCount(
      0
    );
    await expect(page.locator('.state-notice[data-kind="denied"]')).toHaveCount(
      0
    );

    const policyForm = page.locator("#policy-form");
    await expect(policyForm).toBeVisible();
    await expect(policyForm.locator('input[name="ssoRequired"]')).toBeVisible();
    await expect(
      policyForm.locator('input[name="passwordLoginEnabled"]')
    ).toBeVisible();
    await expect(page.locator("#policy-save-button")).toBeVisible();

    const createProviderForm = page.locator("#create-provider-form");
    await expect(createProviderForm).toBeAttached();
    await expect(
      createProviderForm.locator('input[name="providerKey"]')
    ).toBeAttached();
  });
});
