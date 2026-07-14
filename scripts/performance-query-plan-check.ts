/**
 * performance-query-plan-check.ts — `bun run performance:query-plan:check`.
 *
 * Issue #744 (epic #738, platform-evolution, Wave 1). The query-plan half
 * of the performance suite: seeds the `safe` synthetic fixture scale, then
 * runs `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)` for every registered
 * budget (`src/lib/performance/query-plan-budgets.ts`) against a real,
 * RLS-enforced connection (`query-plan-runner.ts`), failing the process if
 * any budget's plan shape or cost/time regresses. This is the "Critical
 * query-plan budgets are versioned and fail on a deliberately introduced
 * regression fixture" acceptance criterion's PRODUCTION-facing half — the
 * adversarial proof that the checker genuinely fires on a bad plan lives
 * in `tests/integration/performance-query-plan-check.integration.test.ts`
 * (this script intentionally does not exercise the regression fixture
 * itself, so a normal run's exit code only ever reflects real, currently-
 * registered budgets).
 *
 * Reuses the SAME target guard as `dr-drill.ts`/`performance-suite.ts`
 * (`authorizeDrDrill`) — never a separate/weaker safety check.
 *
 * Usage:
 *   APP_ENV=test DATABASE_URL=postgres://...@localhost:.../db \
 *   bun run performance:query-plan:check -- --confirm-non-production=test \
 *     [--seed=<string>] [--json-output=<path>]
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { buildFixturePlan } from "../src/lib/performance/fixture-generator";
import {
  resetPerformanceFixtureRows,
  seedPerformanceFixtures
} from "../src/lib/performance/fixture-seeder";
import { runAllQueryPlanChecks } from "../src/lib/performance/query-plan-runner";
import { SAFE_SCALE_PROFILE } from "../src/lib/performance/scale-profiles";
import { authorizeDrDrill } from "../src/lib/resilience/target-guard";

function flagValue(argv: string[], prefix: string): string | null {
  const flag = argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : null;
}

export type QueryPlanCheckOptions = {
  confirmNonProduction: string | null;
  seed: string;
  jsonOutputPath: string | null;
};

export function parseArgs(argv: string[]): QueryPlanCheckOptions {
  return {
    confirmNonProduction: flagValue(argv, "--confirm-non-production="),
    seed: flagValue(argv, "--seed=") ?? "awcms-mini-query-plan-check",
    jsonOutputPath: flagValue(argv, "--json-output=")
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const appEnv = process.env.APP_ENV;
  const databaseUrl = process.env.DATABASE_URL;

  const authorization = authorizeDrDrill({
    appEnv,
    databaseUrl,
    confirmNonProduction: options.confirmNonProduction
  });

  if (!authorization.ok) {
    console.error(
      `\nperformance-query-plan-check: BLOCKED — ${authorization.reason}\n`
    );
    process.exitCode = 1;
    return;
  }

  if (!databaseUrl) {
    console.error(
      "performance-query-plan-check: DATABASE_URL is unexpectedly unset after authorization."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `performance-query-plan-check: target acknowledged (APP_ENV="${appEnv}"). ` +
      `Resetting any prior performance-fixture rows, then seeding "safe" ` +
      `scale fixtures (seed="${options.seed}")...`
  );

  const sql = getDatabaseClient();

  // Issue #782: this step runs in the same CI job/database right after
  // `performance-suite.ts` (its own independent "safe"-scale seed) and
  // `bun test` — with no reset in between, `awcms_mini_audit_events`
  // (and the other driving tables below) accumulate well beyond the
  // single-seed row count every registered budget's `maxTotalCost` was
  // calibrated against, making the EXPLAIN cost this script evaluates
  // depend on PostgreSQL autovacuum's background ANALYZE timing rather
  // than a deterministic, reproducible measurement. Resetting first
  // (scoped to ONLY synthetic `perf-*` fixture tenants — see
  // `resetPerformanceFixtureRows`'s own comment) restores the clean,
  // single-seed baseline every run, every time.
  await resetPerformanceFixtureRows(sql);

  const plan = buildFixturePlan(SAFE_SCALE_PROFILE, options.seed);
  const seedSummary = await seedPerformanceFixtures(sql, plan);

  console.log(
    `performance-query-plan-check: seeded ${plan.tenants.length} tenants in ${seedSummary.durationMs.toFixed(0)}ms.\n`
  );

  // A deterministic, non-noisy-neighbor tenant — representative of ordinary
  // per-tenant query volume rather than the deliberately skewed tenant.
  const tenantId = plan.tenants[0]!.tenantId;
  const results = await runAllQueryPlanChecks(sql, tenantId);

  console.log("=== performance-query-plan-check — results ===");
  for (const result of results) {
    const label = result.ok ? "PASS" : "FAIL";
    console.log(
      `[${label}] ${result.budgetId} — cost=${result.rootTotalCost.toFixed(1)}, ` +
        `execTime=${result.executionTimeMs?.toFixed(1) ?? "n/a"}ms, ` +
        `plan=${result.observedNodeTypes.join(" -> ")}`
    );
    for (const finding of result.findings) {
      console.log(`         ${finding}`);
    }
  }

  const overallOk = results.every((result) => result.ok);
  console.log(`\noverall = ${overallOk ? "PASS" : "FAIL"}`);

  if (options.jsonOutputPath) {
    await Bun.write(
      options.jsonOutputPath,
      JSON.stringify({ seedSummary, results }, null, 2)
    );
    console.log(`Report written to ${options.jsonOutputPath}`);
  }

  if (!overallOk) {
    console.error(
      "\nperformance-query-plan-check: FAIL — one or more query-plan budgets " +
        "regressed (see [FAIL] finding(s) above). If this is an INTENTIONAL " +
        "threshold change, update src/lib/performance/query-plan-budgets.ts's " +
        "`approval` record as part of the same reviewed change."
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
