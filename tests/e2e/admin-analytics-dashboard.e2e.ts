/**
 * E2E spec (Playwright + Bun, skill `awcms-mini-browser-test`) — Issue
 * #622 testing checklist items "aggregate view render" and "raw-detail
 * gating" (epic: visitor analytics #617-#624).
 *
 * Two sequential tests sharing one seeded tenant
 * (`seed-analytics-fixture.ts`, `test.describe.serial` so ordering is
 * guaranteed): the OWNER logs in first (real permission set includes
 * `visitor_analytics.raw_detail.read`), which itself triggers the
 * middleware collector (`src/middleware.ts`, Issue #620) to write a real
 * `awcms_mini_visitor_sessions` row for that visit — carrying a real,
 * non-null `ip_hash` (hashing always runs regardless of the
 * `VISITOR_ANALYTICS_RAW_IP_ENABLED` gate, which only controls the
 * separate raw `ip_address` column; verified empirically against a real
 * dev server + Postgres while implementing this issue). The RESTRICTED
 * VIEWER then logs in with only `dashboard.read`/`sessions.read` (no
 * `raw_detail.read`) and must see that owner-created session row in the
 * table (session listing is tenant-wide, not caller-scoped) WITHOUT its
 * raw ip hash ever appearing anywhere in the rendered table — proving the
 * dashboard renders exactly what `GET /api/v1/analytics/sessions`
 * shaped for this caller (`domain/analytics-response-shaping.ts`,
 * Issue #621) rather than leaking a value some other layer already had.
 *
 * Logs in through the real `/login` form — see
 * `admin-security-disabled.e2e.ts`'s own header comment for why
 * `page.request.post(...)` is deliberately avoided.
 *
 * Requires:
 *   - `E2E_SEED_DATABASE_URL` — the PRIVILEGED (superuser) Postgres role.
 *   - The dev server under `E2E_BASE_URL` (default `http://localhost:4321`)
 *     must be running against the SAME database.
 *
 * Run: `bun run test:e2e tests/e2e/admin-analytics-dashboard.e2e.ts`.
 */
import { test, expect } from "@playwright/test";

import { seedAnalyticsFixture } from "./helpers/seed-analytics-fixture";
import type { SeededAnalyticsFixture } from "./helpers/seed-analytics-fixture";

test.describe
  .serial("admin/analytics — aggregate view + raw-detail gating", () => {
  let fixture: SeededAnalyticsFixture;

  test.beforeAll(async () => {
    const seedDatabaseUrl = process.env.E2E_SEED_DATABASE_URL;
    test.skip(
      !seedDatabaseUrl,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );
    if (!seedDatabaseUrl) return;

    fixture = await seedAnalyticsFixture(
      seedDatabaseUrl,
      `e2e-an-dash-${crypto.randomUUID().slice(0, 8)}`
    );
  });

  test("owner (full permissions) sees the dashboard shell, filters, and raw-detail columns", async ({
    page
  }) => {
    test.skip(
      !process.env.E2E_SEED_DATABASE_URL,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(fixture.tenantId);
    await page.locator("#login-identifier").fill(fixture.owner.loginIdentifier);
    await page.locator("#password").fill(fixture.owner.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/analytics");

    await expect(page.locator('.state-notice[data-kind="denied"]')).toHaveCount(
      0
    );
    await expect(page.locator(".analytics-dashboard")).toBeVisible();

    // Every section this permission set should see.
    await expect(page.locator('[data-section="realtime"]')).toBeVisible();
    await expect(page.locator('[data-section="summary"]')).toBeVisible();
    await expect(page.locator('[data-section="pages"]')).toBeVisible();
    await expect(page.locator('[data-section="devices"]')).toBeVisible();
    await expect(page.locator('[data-section="security"]')).toBeVisible();
    await expect(page.locator('[data-section="sessions"]')).toBeVisible();

    // Filters are present and usable.
    await expect(page.locator("#range-select")).toBeVisible();
    await expect(page.locator("#sessions-area-filter")).toBeVisible();
    await expect(page.locator("#sessions-type-filter")).toBeVisible();

    // Raw-detail columns render for a caller who holds raw_detail.read.
    const sessionsTable = page.locator('[data-role="sessions-table"]');
    await expect(
      sessionsTable.locator("th", { hasText: "IP address" })
    ).toBeVisible();
    await expect(
      sessionsTable.locator("th", { hasText: "IP hash" })
    ).toBeVisible();

    // The client script populates at least one session row (this very
    // page visit is itself collected by the middleware).
    await expect(sessionsTable.locator("tbody tr").first()).toBeVisible({
      timeout: 10_000
    });
  });

  test("a caller without raw_detail.read never sees a raw ip hash/user-agent hash in the sessions table", async ({
    page
  }) => {
    test.skip(
      !process.env.E2E_SEED_DATABASE_URL,
      "E2E_SEED_DATABASE_URL not set — see this file's own header comment."
    );

    await page.goto("/login");
    await page.locator("#tenant-id").fill(fixture.tenantId);
    await page
      .locator("#login-identifier")
      .fill(fixture.restrictedViewer.loginIdentifier);
    await page.locator("#password").fill(fixture.restrictedViewer.password);
    await page.locator("#login-submit").click();
    await page.waitForURL("**/admin");

    await page.goto("/admin/analytics");

    await expect(page.locator('.state-notice[data-kind="denied"]')).toHaveCount(
      0
    );
    await expect(page.locator(".analytics-dashboard")).toBeVisible();

    const sessionsTable = page.locator('[data-role="sessions-table"]');

    // The raw-detail columns must not exist in the DOM at all for this
    // permission set — not merely hidden.
    await expect(
      sessionsTable.locator("th", { hasText: "IP address" })
    ).toHaveCount(0);
    await expect(
      sessionsTable.locator("th", { hasText: "IP hash" })
    ).toHaveCount(0);
    await expect(
      sessionsTable.locator("th", { hasText: "User-agent hash" })
    ).toHaveCount(0);
    await expect(
      sessionsTable.locator("th", { hasText: "Login identifier" })
    ).toHaveCount(0);

    // The table still populates (tenant-wide session listing includes the
    // owner's own earlier session row from the previous test) — proving
    // this is a real render with real data, not an empty/broken table
    // that would trivially "pass" the no-leak assertion below.
    await expect(sessionsTable.locator("tbody tr").first()).toBeVisible({
      timeout: 10_000
    });

    // No raw ip/user-agent hash value (a `sha256:`-prefixed string, the
    // real shape `domain/analytics-response-shaping.ts` produces) ever
    // appears anywhere in the rendered table, proving the dashboard
    // rendered exactly what the API shaped for this caller rather than a
    // value leaking in from some other source.
    const tableText = await sessionsTable.innerText();
    expect(tableText).not.toContain("sha256:");
  });
});
