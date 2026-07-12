/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue
 * #693, epic #679 platform-hardening.
 *
 * Exercises `admin/access-users.astro`'s migration to the new
 * `src/components/ui` primitives: `DataTable` (roles table), `ConfirmDialog`
 * (role deletion — previously a bare `window.prompt` reason capture with NO
 * confirmation step at all), and the create-role `FormField`-wrapped form.
 * Only a real browser render can prove the dialog's focus trap, inline
 * reason-required validation, and Escape-to-cancel behavior — see skill
 * `awcms-mini-browser-test`'s own "when NOT to use" section for why this
 * isn't duplicated as an integration test.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role.
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database.
 *
 * Run: `bun run test:e2e tests/e2e/admin-access-users-migrated.e2e.ts`.
 */
import { test, expect } from "@playwright/test";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

test.describe("admin/access-users — migrated components", () => {
  test("create role via FormField form, then cancel and confirm delete via ConfirmDialog", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-au-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/access-users");

    // Create a non-system role (only non-system roles get a delete button)
    // through the `FormField`-wrapped create-role form.
    const roleCode = `e2erole${Date.now().toString(36)}`;
    await page.locator('summary:has-text("Add role")').click();
    await page.locator("#create-role-code").fill(roleCode);
    await page.locator("#create-role-name").fill("E2E Test Role");
    await page.locator("#create-role-form button[type=submit]").click();

    // The form reloads the page on success (`reloadAfterDelay`).
    await page.waitForURL("**/admin/access-users");
    await expect(page.locator(`code:has-text("${roleCode}")`)).toBeVisible();

    const roleRow = page.locator("tr", {
      has: page.locator(`code:has-text("${roleCode}")`)
    });
    const deleteButton = roleRow.locator(".delete-role-button");

    // --- Cancel branch: Escape closes the dialog, role stays. ---
    await deleteButton.click();
    const dialog = page.locator("#au-confirm-dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(`code:has-text("${roleCode}")`)).toBeVisible();

    // --- Confirm branch, empty reason: inline validation blocks it. ---
    await deleteButton.click();
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-confirm-accept]").click();
    await expect(dialog.locator("[data-confirm-reason-error]")).toBeVisible();
    await expect(dialog).toBeVisible(); // still open — not silently accepted

    // --- Confirm branch, with reason: role is deleted. ---
    await dialog.locator("[data-confirm-reason-input]").fill("E2E cleanup");
    await dialog.locator("[data-confirm-accept]").click();
    await expect(dialog).toBeHidden();

    await page.waitForURL("**/admin/access-users");
    await expect(page.locator(`code:has-text("${roleCode}")`)).toHaveCount(0);
  });
});
