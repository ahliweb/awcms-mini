/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue
 * #693, epic #679 platform-hardening, acceptance criterion "Layout works
 * at 320px, tablet, desktop, zoom 200%, and keyboard-only use."
 *
 * Targets `AdminLayout.astro`'s responsive sidebar/drawer added by this
 * issue: a hamburger toggle (`#admin-nav-toggle`) below `--bp-md` (768px)
 * that opens/closes an off-canvas `<nav id="admin-sidebar-nav">`, a scrim
 * (`#admin-sidebar-scrim`) that closes it on click, Escape-to-close, focus
 * moved into the drawer on open and back to the toggle on close, and the
 * pre-existing skip link (`.skip-link`) plus `aria-current="page"` active-
 * route marking. Only a real browser render can prove focus movement and
 * `aria-expanded` state changes — this is exactly the class of behavior
 * `tests/integration/*.integration.test.ts` cannot exercise (see skill
 * `awcms-mini-browser-test`'s own "when NOT to use" section).
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role,
 *     used once to seed an isolated owner/tenant fixture directly (see
 *     `helpers/seed-owner-tenant.ts`).
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database.
 *
 * Run: `bun run test:e2e tests/e2e/admin-responsive-nav.e2e.ts`.
 */
import { test, expect } from "@playwright/test";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

async function loginAsOwner(
  page: import("@playwright/test").Page,
  owner: { tenantId: string; loginIdentifier: string; password: string }
): Promise<void> {
  await page.goto("/login");
  await page.locator("#tenant-id").fill(owner.tenantId);
  await page.locator("#login-identifier").fill(owner.loginIdentifier);
  await page.locator("#password").fill(owner.password);
  await page.locator("#login-submit").click();
  await page.waitForURL("**/admin");
}

test.describe("AdminLayout — responsive sidebar/drawer", () => {
  test("mobile viewport (320px): drawer opens/closes via toggle, scrim, and Escape, with focus management", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    await page.setViewportSize({ width: 320, height: 720 });

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-nav-mobile-${crypto.randomUUID().slice(0, 8)}`
    );
    await loginAsOwner(page, owner);

    const toggle = page.locator("#admin-nav-toggle");
    const sidebar = page.locator("#admin-sidebar-nav");
    const scrim = page.locator("#admin-sidebar-scrim");

    await expect(toggle).toBeVisible();
    await expect(sidebar).toHaveAttribute("data-open", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Open via toggle — sidebar becomes open, focus moves into it, scrim
    // appears.
    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-open", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(scrim).toBeVisible();

    const firstNavLink = sidebar.locator("a").first();
    await expect(firstNavLink).toBeFocused();

    // Escape closes it and returns focus to the toggle button.
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveAttribute("data-open", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();

    // Re-open, then close via the scrim (click dismiss).
    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-open", "true");
    // Click a point OUTSIDE the drawer's own width (min(280px, 85vw) — at a
    // 320px viewport that's 272px) so this actually hits the scrim behind
    // it, not the drawer panel itself sitting on top at a lower x.
    await scrim.click({ position: { x: 300, y: 300 } });
    await expect(sidebar).toHaveAttribute("data-open", "false");
  });

  test("desktop viewport (1280px): sidebar is always visible, no toggle needed", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    await page.setViewportSize({ width: 1280, height: 800 });

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-nav-desktop-${crypto.randomUUID().slice(0, 8)}`
    );
    await loginAsOwner(page, owner);

    const toggle = page.locator("#admin-nav-toggle");
    const sidebar = page.locator("#admin-sidebar-nav");

    await expect(toggle).toBeHidden();
    await expect(sidebar).toBeVisible();

    const dashboardLink = sidebar.locator('a[href="/admin"]');
    await expect(dashboardLink).toHaveAttribute("aria-current", "page");
  });

  test("skip link jumps keyboard focus straight to main content", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-nav-skip-${crypto.randomUUID().slice(0, 8)}`
    );
    await loginAsOwner(page, owner);

    // The skip link is the very first focusable element in <body>.
    await page.keyboard.press("Tab");
    const skipLink = page.locator(".skip-link");
    await expect(skipLink).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.locator("#admin-main-content")).toBeFocused();
  });
});
