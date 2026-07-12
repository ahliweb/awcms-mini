/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue
 * #693, epic #679 platform-hardening.
 *
 * Exercises `admin/tenant/domains.astro`'s migration to the new
 * `src/components/ui` primitives: `DataTable`, `StatusBadge`, and
 * `ConfirmDialog` for all three of its destructive/high-risk actions
 * (verify, set-primary, delete-with-reason) — previously three different
 * combinations of bare `window.confirm`/`window.prompt` with zero inline
 * validation. Only a real browser render can prove the dialog opens with
 * the right per-action title/body, blocks an empty required reason inline,
 * and actually drives the real `/api/v1/tenant/domains/**` endpoints end to
 * end.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role.
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database.
 *
 * Run: `bun run test:e2e tests/e2e/admin-tenant-domains-migrated.e2e.ts`.
 */
import { test, expect } from "@playwright/test";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

test.describe("admin/tenant/domains — migrated components", () => {
  test("create, verify, set-primary, and delete a domain through ConfirmDialog", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-dom-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/tenant/domains");

    const hostname = `e2e-${Date.now().toString(36)}.example.com`;
    await page.locator('summary:has-text("Add a domain")').click();
    await page.locator('input[name="hostname"]').fill(hostname);
    // `verify` (below) requires `verification_method` to be set on the row
    // (`verifyTenantDomain` returns `missing_verification_method` otherwise,
    // surfaced as an error banner, never flipping status to `active`) — the
    // create form's default "none" option would make the verify step fail.
    await page
      .locator('#create-domain-form select[name="verificationMethod"]')
      .selectOption("dns_txt");
    await page.locator("#create-domain-form button[type=submit]").click();
    await page.waitForURL("**/admin/tenant/domains");

    const row = page.locator("tr", {
      has: page.locator(`code:has-text("${hostname}")`)
    });
    await expect(row).toBeVisible();

    const dialog = page.locator("#domain-confirm-dialog");

    // --- Verify: cancel via Escape first, domain stays pending. ---
    await row.locator(".verify-domain-button").click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-confirm-title]")).toHaveText(
      "Verify domain?"
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // --- Verify: confirm this time. ---
    await row.locator(".verify-domain-button").click();
    await dialog.locator("[data-confirm-accept]").click();
    await expect(dialog).toBeHidden();
    await page.waitForURL("**/admin/tenant/domains");

    // --- Set primary. ---
    const rowAfterVerify = page.locator("tr", {
      has: page.locator(`code:has-text("${hostname}")`)
    });
    await rowAfterVerify.locator(".set-primary-domain-button").click();
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-confirm-accept]").click();
    await page.waitForURL("**/admin/tenant/domains");

    const rowAfterPrimary = page.locator("tr", {
      has: page.locator(`code:has-text("${hostname}")`)
    });
    await expect(rowAfterPrimary.locator(".primary-badge")).toBeVisible();

    // --- Delete: empty reason is blocked inline, then succeeds with one. ---
    await rowAfterPrimary.locator(".delete-domain-button").click();
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-confirm-accept]").click();
    await expect(dialog.locator("[data-confirm-reason-error]")).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog
      .locator("[data-confirm-reason-input]")
      .fill("E2E cleanup — no longer needed");
    await dialog.locator("[data-confirm-accept]").click();
    await expect(dialog).toBeHidden();

    await page.waitForURL("**/admin/tenant/domains");
    await expect(page.locator(`code:has-text("${hostname}")`)).toHaveCount(0);
  });
});
