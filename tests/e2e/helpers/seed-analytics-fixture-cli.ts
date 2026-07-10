/**
 * Standalone CLI entry point for `seed-analytics-fixture.ts`'s seeding
 * logic — run as a SEPARATE `bun` subprocess by `seedAnalyticsFixture()`,
 * same reasoning as `seed-owner-tenant-cli.ts` (argon2 hashing + several
 * sequential `Bun.SQL` queries in the same process driving Playwright's
 * browser can intermittently break its IPC channel).
 *
 * Usage: `bun tests/e2e/helpers/seed-analytics-fixture-cli.ts <databaseUrl> <tenantCode>`
 * — prints one JSON line (`SeededAnalyticsFixture`) to stdout on success.
 */
import { seedAnalyticsFixtureInProcess } from "./seed-analytics-fixture";

const [databaseUrl, tenantCode] = process.argv.slice(2);

if (!databaseUrl || !tenantCode) {
  console.error(
    "Usage: bun seed-analytics-fixture-cli.ts <databaseUrl> <tenantCode>"
  );
  process.exit(1);
}

const fixture = await seedAnalyticsFixtureInProcess(databaseUrl, tenantCode);
console.log(JSON.stringify(fixture));
