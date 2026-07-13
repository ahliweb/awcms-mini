/**
 * performance-suite.ts — `bun run performance:suite`.
 *
 * Issue #744 (epic #738, platform-evolution, Wave 1). Reproducible
 * performance suite: seeds deterministic synthetic multi-tenant fixtures
 * (`src/lib/performance/fixture-generator.ts`/`fixture-seeder.ts`), then
 * runs load/soak/mixed-workload/saturation-and-recovery scenarios
 * (`src/lib/performance/scenarios/*.ts`) that each exercise a REAL
 * work-class-gated code path (`withTenant`/`acquireWorkClassSlot`, Issue
 * #743) — never a simulated or reimplemented mechanism.
 *
 * SAFETY INTERLOCK: reuses `authorizeDrDrill`
 * (`src/lib/resilience/target-guard.ts`) UNCHANGED — the exact same
 * production-target guard `scripts/dr-drill.ts` already uses (Issue #699).
 * `APP_ENV=production` is an unconditional, non-overridable refusal; the
 * `DATABASE_URL` host must be a recognized local/isolated database
 * (default-deny for anything else); an explicit
 * `--confirm-non-production=<APP_ENV value>` typo-catcher is required.
 *
 * Two lanes, mirroring `dr-drill.ts`'s own `--full` convention:
 * - Safe (default): `safe` fixture scale, 5 scenarios, seconds to run —
 *   the subset wired into `bun run check`/CI on every PR.
 * - Full (`--full`): `large` fixture scale by default (override with
 *   `--scale=`), adds the long-running soak-stability scenario — run on
 *   demand/schedule, never on every PR (see
 *   `docs/awcms-mini/performance-suite.md` §Safe subset vs. full lane).
 *
 * Usage:
 *   APP_ENV=test DATABASE_URL=postgres://...@localhost:.../db \
 *   bun run performance:suite -- --confirm-non-production=test \
 *     [--full] [--scale=safe|standard|large] [--seed=<string>] \
 *     [--json-output=<path>] [--report-path=<path>]
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { buildFixturePlan } from "../src/lib/performance/fixture-generator";
import { seedPerformanceFixtures } from "../src/lib/performance/fixture-seeder";
import {
  buildEnvironmentMetadata,
  buildHumanReport,
  redactReport,
  type PerformanceReport
} from "../src/lib/performance/report";
import { resolveScaleProfile } from "../src/lib/performance/scale-profiles";
import { setPerformanceScenarioState } from "../src/lib/performance/scenario-context";
import { backgroundSyncClaimLoadScenario } from "../src/lib/performance/scenarios/background-sync-claim-load";
import { criticalTransactionIntegrityScenario } from "../src/lib/performance/scenarios/critical-transaction-integrity";
import { interactiveLoadScenario } from "../src/lib/performance/scenarios/interactive-load";
import { reportingUnderLoadScenario } from "../src/lib/performance/scenarios/reporting-under-load";
import { saturationAndRecoveryScenario } from "../src/lib/performance/scenarios/saturation-and-recovery";
import { soakStabilityScenario } from "../src/lib/performance/scenarios/soak-stability";
import { authorizeDrDrill } from "../src/lib/resilience/target-guard";
import {
  computeDrOverall,
  runScenario,
  type ScenarioContext,
  type ScenarioDefinition,
  type ScenarioResult
} from "../src/lib/resilience/scenario-runner";

export type PerformanceSuiteOptions = {
  full: boolean;
  confirmNonProduction: string | null;
  scaleOverride: string | null;
  seed: string;
  jsonOutputPath: string | null;
  reportPath: string | null;
};

function flagValue(argv: string[], prefix: string): string | null {
  const flag = argv.find((arg) => arg.startsWith(prefix));
  return flag ? flag.slice(prefix.length) : null;
}

export function parseArgs(argv: string[]): PerformanceSuiteOptions {
  return {
    full: argv.includes("--full"),
    confirmNonProduction: flagValue(argv, "--confirm-non-production="),
    scaleOverride: flagValue(argv, "--scale="),
    seed: flagValue(argv, "--seed=") ?? "awcms-mini-performance-suite",
    jsonOutputPath: flagValue(argv, "--json-output="),
    reportPath: flagValue(argv, "--report-path=")
  };
}

/** The "safe" tier: every scenario here is fast, deterministic, and safe to run on every PR. */
function buildSafeScenarios(): ScenarioDefinition[] {
  return [
    interactiveLoadScenario(),
    criticalTransactionIntegrityScenario(),
    reportingUnderLoadScenario(),
    backgroundSyncClaimLoadScenario(),
    saturationAndRecoveryScenario()
  ];
}

function buildScenarios(full: boolean): ScenarioDefinition[] {
  return full
    ? [...buildSafeScenarios(), soakStabilityScenario()]
    : buildSafeScenarios();
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
    console.error(`\nperformance-suite: BLOCKED — ${authorization.reason}\n`);
    process.exitCode = 1;
    return;
  }

  if (!databaseUrl) {
    // Unreachable in practice (authorizeDrDrill already refuses an unset
    // DATABASE_URL), kept only so TypeScript can narrow below.
    console.error(
      "performance-suite: DATABASE_URL is unexpectedly unset after authorization."
    );
    process.exitCode = 1;
    return;
  }

  const defaultProfileId = options.full ? "large" : "safe";
  const scaleProfile = resolveScaleProfile(
    options.scaleOverride ?? defaultProfileId
  );

  console.log(
    `performance-suite: target acknowledged (APP_ENV="${appEnv}"). Running the ` +
      `${options.full ? "FULL" : "safe subset"} of scenarios at scale "${scaleProfile.id}" ` +
      `(${scaleProfile.label}).\n`
  );

  const sql = getDatabaseClient();
  const plan = buildFixturePlan(scaleProfile, options.seed);

  console.log(
    `performance-suite: seeding synthetic fixtures (${plan.tenants.length} tenants, seed="${options.seed}")...`
  );
  const seedSummary = await seedPerformanceFixtures(sql, plan);
  console.log(
    `performance-suite: seeded in ${seedSummary.durationMs.toFixed(0)}ms.\n`
  );

  setPerformanceScenarioState({ sql, plan, scaleProfile });

  const scenarios = buildScenarios(options.full);
  const ctx: ScenarioContext = { databaseUrl, env: process.env };
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(
      `=== performance-suite — ${scenario.name} (${scenario.tier}) ===`
    );
    const result = await runScenario(scenario, ctx);
    const label =
      result.status === "pass"
        ? "PASS"
        : result.status === "skipped"
          ? "SKIP"
          : "FAIL";
    console.log(
      `[${label}] ${scenario.name} — ${result.detail} (${result.durationMs.toFixed(0)}ms)`
    );
    results.push(result);
  }

  const overall = computeDrOverall(results);
  const environment = buildEnvironmentMetadata({
    appEnv,
    databaseUrl,
    scaleProfile
  });

  const report: PerformanceReport = {
    environment,
    tier: options.full ? "full" : "safe",
    overall,
    scenarios: results,
    queryPlanChecks: [],
    seedSummary
  };
  const redacted = redactReport(report);

  console.log("\n=== performance-suite — summary ===");
  for (const result of results) {
    const label =
      result.status === "pass"
        ? "PASS"
        : result.status === "skipped"
          ? "SKIP"
          : "FAIL";
    console.log(`[${label}] ${result.name}`);
  }
  console.log(`\noverall = ${overall}`);

  if (options.jsonOutputPath) {
    await Bun.write(options.jsonOutputPath, JSON.stringify(redacted, null, 2));
    console.log(`Machine-readable report written to ${options.jsonOutputPath}`);
  }

  if (options.reportPath) {
    await Bun.write(options.reportPath, buildHumanReport(redacted));
    console.log(`Human report written to ${options.reportPath}`);
  }

  if (overall !== "pass") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
