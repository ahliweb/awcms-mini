/**
 * E2E admin publish flow for `service_catalog` (Issue #870, epic #868,
 * ADR-0022). Drives the real admin UI through the full operator loop: create a
 * draft plan, then publish it into an immutable offer, asserting the visible
 * draft -> published state transition.
 *
 * Requires (same as every admin E2E spec, see `admin-security-enabled.e2e.ts`):
 *   - `E2E_SEED_DATABASE_URL` (a superuser role) — used by the seed CLI.
 *   - a dev server on `E2E_BASE_URL` pointed at the same database.
 * Run: `bun run test:e2e tests/e2e/service-catalog-publish.e2e.ts`.
 *
 * The seed CLI (`seed-service-catalog-cli.ts`) ENABLES `service_catalog` for
 * the fresh tenant, because the module is `defaultTenantState: "disabled"`
 * (ADR-0022 §7): without an explicit enabled row the SSR permission gate would
 * strip its keys and the page would render the denied notice.
 */
import { test, expect } from "@playwright/test";

async function seedServiceCatalogTenant(
  databaseUrl: string,
  tenantCode: string
): Promise<{ tenantId: string; loginIdentifier: string; password: string }> {
  const cliPath = new URL(
    "./helpers/seed-service-catalog-cli.ts",
    import.meta.url
  ).pathname;
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
      `seed-service-catalog-cli.ts failed (exit ${exitCode}): ${stderr}`
    );
  }
  return JSON.parse(stdout.trim());
}

/**
 * Issue #879 (ADR-0022 §5 HIGH-2) — commercially APPROVE the draft version
 * out-of-band as a DISTINCT approver before the operator publishes. `publishVersion`
 * now refuses an un-approved version and refuses a publisher equal to the approver
 * (maker/checker); the admin approve UI is #878 scope. The approver id is a fresh
 * random uuid (never the publisher), so maker != checker holds.
 */
async function approveOfferVersionOutOfBand(
  databaseUrl: string,
  tenantId: string,
  planKey: string,
  version: number
): Promise<void> {
  const cliPath = new URL(
    "./helpers/approve-offer-version-cli.ts",
    import.meta.url
  ).pathname;
  const proc = Bun.spawn(
    ["bun", cliPath, databaseUrl, tenantId, planKey, String(version)],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `approve-offer-version-cli.ts failed (exit ${exitCode}): ${stderr}`
    );
  }
}

test.describe("admin/service-catalog — create + publish flow", () => {
  test("an operator creates a draft plan and publishes it into an offer", async ({
    page
  }) => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    const planKey = `e2e_plan_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const owner = await seedServiceCatalogTenant(
      seedDatabaseUrl!,
      `e2e-sc-${crypto.randomUUID().slice(0, 8)}`
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(owner.tenantId);
    await page.locator("#login-identifier").fill(owner.loginIdentifier);
    await page.locator("#password").fill(owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/service-catalog/plans");

    // Module is enabled for this tenant → the page renders, not the denied notice.
    await expect(page.locator('.state-notice[data-kind="denied"]')).toHaveCount(
      0
    );

    // Create a draft plan.
    await page.locator("details.create-plan summary").click();
    await page.locator('#create-form input[name="planKey"]').fill(planKey);
    await page.locator('#create-form input[name="name"]').fill("E2E Plan");
    await page.locator('#create-form input[name="currency"]').fill("USD");
    await page.locator('#create-form button[type="submit"]').click();

    // The create handler redirects to the detail view for the new plan.
    await page.waitForURL(`**/admin/service-catalog/plans?plan=${planKey}`);

    // The draft version (v1) is visible with a draft status.
    const draftRow = page.locator('tr[data-version="1"]');
    await expect(draftRow).toHaveAttribute("data-status", "draft");

    // Issue #879 — a DISTINCT approver must commercially approve v1 before it can
    // be published (maker/checker). Done out-of-band here (the approve UI is #878
    // scope); the operator remains the publisher, so approver != publisher holds.
    await approveOfferVersionOutOfBand(
      seedDatabaseUrl!,
      owner.tenantId,
      planKey,
      1
    );
    // Reload so the detail view reflects the now-approved (still draft) version.
    await page.goto(`/admin/service-catalog/plans?plan=${planKey}`);
    await expect(page.locator('tr[data-version="1"]')).toHaveAttribute(
      "data-status",
      "draft"
    );

    // Publish v1 (the operator, a different actor than the approver).
    await page.locator('tr[data-version="1"] button.publish-button').click();

    // The page reloads after a successful publish (reloadAfterDelay). Poll the
    // reloaded detail view until v1 shows as published — a re-query, not a
    // longer fixed wait (repo lesson #883, browser-test convention #6).
    await expect
      .poll(
        async () => {
          const status = await page
            .locator('tr[data-version="1"]')
            .getAttribute("data-status");
          if (status === "published") return "published";
          // Not there yet: re-load the detail view and re-check.
          await page.goto(`/admin/service-catalog/plans?plan=${planKey}`);
          return status;
        },
        { timeout: 15000, intervals: [500, 1000, 1500] }
      )
      .toBe("published");
  });
});
