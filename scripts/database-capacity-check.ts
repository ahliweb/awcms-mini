/**
 * database-capacity-check.ts — `bun run database:capacity:check`.
 *
 * Issue #743 (epic #738, platform-evolution, Wave 1). Standalone CLI wrapper
 * around `evaluateCapacityBudget` (`src/lib/database/capacity-config.ts`) —
 * read-only, no database connection, no network call: every input is
 * `process.env`. This is the SAME evaluation `scripts/production-preflight.ts`
 * runs as its `database:capacity` stage; this script exists so an operator
 * can run just this one check on demand (e.g. while tuning
 * `DATABASE_CAPACITY_*` env vars before a scale-out) without running the
 * full preflight sequence.
 *
 * Exit code: 0 when `report.ok` (no `fail`-severity finding and the
 * worst-case configured instance count fits the approved budget), 1
 * otherwise. `warning`-severity findings are printed but never fail the
 * command — see `capacity-config.ts`'s header comment on why the
 * work-class/pool oversubscription check is a warning, not a hard gate.
 *
 * Also emits the `db_pool_capacity_*` gauges (Issue #743,
 * `src/lib/observability/metrics-port.ts`) so a process that runs this
 * script (or the equivalent preflight stage) on a schedule feeds a
 * real metrics adapter, not just stdout.
 */
import {
  emitCapacityGauges,
  evaluateCapacityBudget,
  loadCapacityConfigFromEnv,
  type CapacityBudgetReport
} from "../src/lib/database/capacity-config";

function formatUsageLine(
  label: string,
  usage: CapacityBudgetReport["expected"]
): string {
  const perClass = usage.perClass
    .map(
      (entry) =>
        `${entry.processClass}=${entry.instanceCount}x${entry.poolMax}=${entry.connections}`
    )
    .join(", ");

  return `${label}: ${perClass} -> total ${usage.totalConnections}`;
}

export function formatCapacityReport(report: CapacityBudgetReport): string {
  const lines: string[] = [];

  lines.push(formatUsageLine("expected", report.expected));
  lines.push(formatUsageLine("worst-case (max)", report.worstCase));
  lines.push(
    `approved connections: ${report.approvedConnections} ` +
      `(reserved admin headroom: ${report.reservedAdminHeadroom}, ` +
      `available for runtime pools: ${report.availableForRuntime})`
  );
  lines.push(
    report.pgBouncer.enabled
      ? `PgBouncer profile: max_client_conn=${report.pgBouncer.maxClientConnections}, ` +
          `default_pool_size=${report.pgBouncer.defaultPoolSize}`
      : "PgBouncer profile: disabled (direct PostgreSQL)"
  );
  lines.push(
    `exceeds budget — expected: ${report.exceedsAtExpected ? "YES" : "no"}, ` +
      `max: ${report.exceedsAtMax ? "YES" : "no"}`
  );

  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of report.findings) {
      lines.push(
        `[${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`
      );
    }
  }

  return lines.join("\n");
}

async function main() {
  const config = loadCapacityConfigFromEnv();
  const report = evaluateCapacityBudget(config);

  emitCapacityGauges(report);

  console.log("=== database:capacity:check ===");
  console.log(formatCapacityReport(report));

  if (report.ok) {
    console.log("\ndatabase:capacity:check OK.");
  } else {
    console.error(
      "\ndatabase:capacity:check FAIL — unsafe or internally inconsistent capacity configuration " +
        "(see [FAIL] finding(s) above). Preflight/deployment must not proceed until resolved."
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
