/**
 * E2E for the payment-gateway operator screen (Issue #878, epic #868).
 *
 * WHY AN E2E AND NOT ONLY UNIT TESTS. The defect this page fixes was precisely
 * a route that did not exist behind a declared sidebar link, and the page is an
 * SSR Astro file: its permission gating, its island, and the fact that the URL
 * resolves at all are invisible to `tsc --noEmit` (which does not check
 * `.astro`) and to every unit test in this repo. `bun run check` does not run
 * E2E either — this spec is the only thing that proves the screen actually
 * loads for a permitted operator.
 *
 * Requires (same as every admin E2E spec, see `admin-security-enabled.e2e.ts`):
 *   - `E2E_SEED_DATABASE_URL` (a superuser role) — used by the seed CLI;
 *   - a dev server on `E2E_BASE_URL` pointed at the same database.
 * Run: `bun run test:e2e tests/e2e/payment-gateway-operator.e2e.ts`
 * (never bare `playwright test` — it silently runs under Node.js).
 *
 * The seed CLI ENABLES `payment_gateway` for the fresh tenant, because the
 * module is `defaultTenantState: "disabled"` (ADR-0022 §7): without an explicit
 * enabled row the SSR permission gate strips its keys and the page renders the
 * denied notice.
 */
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FAILING_IMPACTS = new Set(["serious", "critical"]);

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

async function seedTenantWithPaymentGateway(
  databaseUrl: string,
  tenantCode: string
): Promise<{ tenantId: string; loginIdentifier: string; password: string }> {
  const cliPath = new URL(
    "./helpers/seed-module-enabled-cli.ts",
    import.meta.url
  ).pathname;
  const proc = Bun.spawn(
    ["bun", cliPath, databaseUrl, tenantCode, "payment_gateway"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `seed-module-enabled-cli.ts failed (exit ${exitCode}): ${stderr}`
    );
  }
  return JSON.parse(stdout.trim());
}

test.describe("admin/payment-gateway — operator read surface", () => {
  test("a permitted operator reaches the screen and looks a tenant up", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const owner = await seedTenantWithPaymentGateway(
      seedDatabaseUrl!,
      `e2e-pg-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    // The sidebar link the module descriptor declares must actually go
    // somewhere — this is the regression that motivated the whole page.
    const navLink = page.locator('a[href="/admin/payment-gateway"]').first();
    await expect(navLink).toBeVisible();
    await navLink.click();
    await page.waitForURL("**/admin/payment-gateway");

    // Module enabled for this tenant + owner holds every permission → the real
    // screen renders, not the denied notice and not a 404.
    await expect(page.locator('.state-notice[data-kind="denied"]')).toHaveCount(
      0
    );
    await expect(page.locator("#lookup-form")).toBeVisible();

    // Look the tenant up against itself (self-read is always authorized; this
    // needs no seeded provider data to exercise the island end to end).
    await page
      .locator('#lookup-form input[name="tenantId"]')
      .fill(owner.tenantId);
    await page.locator('#lookup-form button[type="submit"]').click();

    // All three sections resolve. With no provider data seeded they land on the
    // EMPTY state — which must be visibly distinct from a denial or an error,
    // so assert the heading rendered rather than merely that the box is shown.
    for (const sectionId of ["health", "accounts", "intents"]) {
      const section = page.locator(`#${sectionId}`);
      await expect(section).toBeVisible();
      await expect(section.locator("h3")).toBeVisible();
    }

    await assertNoSeriousViolations(page, "/admin/payment-gateway");
  });
});
