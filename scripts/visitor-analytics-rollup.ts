/**
 * visitor-analytics-rollup.ts — `bun run analytics:rollup`.
 *
 * Issue #624 (epic: visitor analytics #617-#624 — rollup job, retention
 * purge, readiness checks, docs). Internal worker entrypoint for
 * `rollupVisitorAnalyticsForDate`
 * (`src/modules/visitor-analytics/application/rollup.ts`) — intended to be
 * run on a schedule (cron/systemd timer/k8s CronJob), same pattern as
 * `scripts/audit-log-purge.ts` (Issue #447): not exposed over HTTP, no
 * tenant-scoped role can trigger this aggregation over the API.
 *
 * Iterates every `active` tenant and rolls up one or more calendar dates,
 * in this priority order:
 *   1. `--date=YYYY-MM-DD` — a single specific date.
 *   2. `--start-date=YYYY-MM-DD --end-date=YYYY-MM-DD` (both required
 *      together) — an inclusive UTC date range, for backfilling.
 *   3. Default: yesterday (UTC) only — the day a daily cron run at, say,
 *      00:15 UTC would want to finalize, since "today" is still live/
 *      incomplete. Running this job more than once for the same date is
 *      always safe: `rollupVisitorAnalyticsForDate` fully recomputes and
 *      UPSERTs each `(tenant, date, area)` row, it never increments an
 *      existing one.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { withTenant } from "../src/lib/database/tenant-context";
import { rollupVisitorAnalyticsForDate } from "../src/modules/visitor-analytics/application/rollup";

type TenantRow = { id: string };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isValidDateOnly(value: string): boolean {
  return DATE_ONLY_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const flag = argv.find((arg) => arg.startsWith(prefix));

  return flag ? flag.slice(prefix.length) : undefined;
}

export function resolveDatesToRollup(argv: string[], now: Date): string[] {
  const singleDate = readFlag(argv, "date");

  if (singleDate) {
    if (!isValidDateOnly(singleDate)) {
      throw new Error(
        `--date must be a valid YYYY-MM-DD date; got "${singleDate}".`
      );
    }
    return [singleDate];
  }

  const startDate = readFlag(argv, "start-date");
  const endDate = readFlag(argv, "end-date");

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      throw new Error(
        "--start-date and --end-date must both be provided together."
      );
    }
    if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate)) {
      throw new Error(
        `--start-date/--end-date must be valid YYYY-MM-DD dates; got "${startDate}"/"${endDate}".`
      );
    }

    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);

    if (start > end) {
      throw new Error(
        `--start-date (${startDate}) must not be after --end-date (${endDate}).`
      );
    }

    const dates: string[] = [];
    for (
      let cursor = start;
      cursor <= end;
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    ) {
      dates.push(toDateOnly(cursor));
    }
    return dates;
  }

  // Default: yesterday (UTC) — today's data is still live/incomplete.
  return [toDateOnly(new Date(now.getTime() - 24 * 60 * 60 * 1000))];
}

async function main() {
  const sql = getDatabaseClient();
  const correlationId = crypto.randomUUID();
  const now = new Date();
  const dates = resolveDatesToRollup(process.argv.slice(2), now);

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as TenantRow[];

    let totalAreaRowsUpserted = 0;

    for (const tenant of tenants) {
      for (const date of dates) {
        const result = await withTenant(
          sql,
          tenant.id,
          (tx) => rollupVisitorAnalyticsForDate(tx, tenant.id, date),
          { workClass: "maintenance" }
        );

        totalAreaRowsUpserted += result.areasProcessed;
      }
    }

    console.log(
      `analytics:rollup complete — correlationId=${correlationId} ` +
        `dates=${dates.join(",")} tenants=${tenants.length} ` +
        `areaRowsUpserted=${totalAreaRowsUpserted}`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`analytics:rollup FAILED — ${detail}`);
    process.exitCode = 1;
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
