/**
 * Reference E2E spec (Playwright + Bun) — see skill
 * `.claude/skills/awcms-mini-browser-test/SKILL.md`. Targets `/login.astro`
 * because it renders correctly with zero seeded tenant/user data (only a
 * live DB connection to boot the app), keeping this spec runnable against
 * any freshly-migrated database rather than requiring fixture setup.
 *
 * Run: `bun run dev` (or `preview`) in one terminal with `DATABASE_URL`
 * set, then `bun run test:e2e` in another.
 */
import { test, expect } from "@playwright/test";

test.describe("login page", () => {
  test("renders the login form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.locator("#login-form")).toBeVisible();
    await expect(page.locator("#tenant-id")).toBeVisible();
    await expect(page.locator("#login-identifier")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#login-submit")).toBeVisible();
  });

  test("rejects an unknown identity with a generic error, not a stack trace", async ({
    page
  }) => {
    await page.goto("/login");

    await page
      .locator("#tenant-id")
      .fill("00000000-0000-0000-0000-000000000000");
    await page.locator("#login-identifier").fill("no-such-user@example.com");
    await page.locator("#password").fill("wrong-password-but-long-enough");
    await page.locator("#login-submit").click();

    const error = page.locator("#login-error");
    await expect(error).toBeVisible();

    const errorText = (await error.textContent())?.trim() ?? "";
    expect(errorText.length).toBeGreaterThan(0);
    expect(errorText.toLowerCase()).not.toContain("stack");
    expect(errorText.toLowerCase()).not.toContain("at object");
    expect(errorText.toLowerCase()).not.toContain("postgres");
  });
});
