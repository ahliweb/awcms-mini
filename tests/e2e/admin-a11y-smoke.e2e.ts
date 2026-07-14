/**
 * Automated accessibility smoke test (Playwright + Bun + `@axe-core/
 * playwright`) — Issue #693, epic #679 platform-hardening, acceptance
 * criterion "Components meet WCAG 2.2 AA semantics/contrast/focus
 * requirements" and "automated accessibility smoke test[s] cover
 * navigation and migrated pages."
 *
 * `@axe-core/playwright` is a plain JS library (no Node-only build
 * tooling, works the same as `@playwright/test` itself under `bun --bun
 * playwright test` — AGENTS.md rule #14 Bun-only concern is about
 * runtime/build tooling, not about auditing dependencies used from within
 * an already-Bun-run test process) — added as a devDependency
 * specifically for this issue (`bun add -d @axe-core/playwright`).
 *
 * Scans the admin shell (nav/topbar/skip-link — `AdminLayout.astro`) and
 * the two pages Issue #693 migrated to the new `src/components/ui`
 * primitives (`access-users`, `tenant/domains`) with axe-core's
 * `wcag2a`/`wcag2aa`/`wcag21aa`/`wcag22aa` rule tags. Fails the test on
 * any violation of "critical" or "serious" impact — "moderate"/"minor"
 * findings on pages this issue did not touch (e.g. third-party markup
 * quirks unrelated to this issue's scope) are out of scope for a smoke
 * gate and would make this test a source of unrelated flakiness; see
 * `awcms-mini-ux-review` skill for a full page-by-page audit instead.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role.
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database.
 *
 * Run: `bun run test:e2e tests/e2e/admin-a11y-smoke.e2e.ts`.
 */
import { test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { seedOwnerTenant } from "./helpers/seed-owner-tenant";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const FAILING_IMPACTS = new Set(["critical", "serious"]);

async function assertNoSeriousViolations(
  page: Page,
  label: string
): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const seriousOrCritical = results.violations.filter(
    (violation) => violation.impact && FAILING_IMPACTS.has(violation.impact)
  );

  if (seriousOrCritical.length > 0) {
    const summary = seriousOrCritical
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.nodes.length} node(s) — ${violation.help}`
      )
      .join("\n");
    throw new Error(
      `${label}: ${seriousOrCritical.length} critical/serious a11y violation(s):\n${summary}`
    );
  }
}

test.describe("Admin — accessibility smoke (axe-core, WCAG 2.2 AA)", () => {
  test("login page has no critical/serious violations", async ({ page }) => {
    await page.goto("/login");
    await assertNoSeriousViolations(page, "/login");
  });

  test("admin shell + migrated pages have no critical/serious violations", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedOwnerTenant(
      seedDatabaseUrl!,
      `e2e-a11y-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");
    await assertNoSeriousViolations(page, "/admin (dashboard + shell/nav)");

    await page.goto("/admin/access-users");
    await assertNoSeriousViolations(page, "/admin/access-users");

    await page.goto("/admin/tenant/domains");
    await assertNoSeriousViolations(page, "/admin/tenant/domains");

    // Mobile viewport (320px) with the drawer open — the shape acceptance
    // criteria call out explicitly ("Layout works at 320px... and
    // keyboard-only use").
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/admin");
    await page.locator("#admin-nav-toggle").click();
    await assertNoSeriousViolations(page, "/admin at 320px with drawer open");
  });
});
