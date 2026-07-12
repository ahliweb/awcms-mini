/**
 * dr-drill.ts — `bun run resilience:dr-drill`.
 *
 * Issue #699 (epic #679, platform-hardening). Failure-injection and
 * disaster-recovery verification: runs a set of non-destructive,
 * deterministic scenarios (`src/lib/resilience/scenarios/*.ts`) proving
 * documented recovery behavior actually holds — PostgreSQL disconnect,
 * pool saturation, worker interruption, and partial SSO/email provider
 * outages in the default "safe" tier (CI-safe: fast, no real network
 * calls, no destructive infra); backup/restore/rollback verification
 * (reusing Issue #691's `deploy/backup/restore-drill.sh`) additionally in
 * the "full" tier (`--full`, slower, needs version-matched `pg_dump`/
 * `pg_restore`; run on demand/schedule, not on every PR — see
 * `docs/awcms-mini/resilience-dr-verification.md` §CI safe subset vs.
 * full drill cadence).
 *
 * SAFETY INTERLOCK (the issue's own first acceptance criterion): before
 * ANY scenario runs, `authorizeDrDrill` (`src/lib/resilience/
 * target-guard.ts`) must authorize the run — `APP_ENV=production` is an
 * unconditional, non-overridable refusal, and the DATABASE_URL host must
 * be a recognized local/isolated database (default-deny for anything
 * else), plus an explicit `--confirm-non-production=<APP_ENV value>`
 * typo-catcher (mirrors `production-preflight.ts`'s
 * `--acknowledge-target`). No flag combination can make this drill target
 * anything that looks like production.
 *
 * Usage:
 *   APP_ENV=test DATABASE_URL=postgres://...@localhost:.../db \
 *   bun run resilience:dr-drill -- --confirm-non-production=test [--full] [--json-output=<path>]
 */
import { authorizeDrDrill } from "../src/lib/resilience/target-guard";
import {
  computeDrOverall,
  runScenario,
  type ScenarioContext,
  type ScenarioDefinition,
  type ScenarioResult
} from "../src/lib/resilience/scenario-runner";
import { backupRestoreDrillScenario } from "../src/lib/resilience/scenarios/backup-restore-drill";
import { emailProviderOutageScenario } from "../src/lib/resilience/scenarios/email-provider-outage";
import { poolSaturationScenario } from "../src/lib/resilience/scenarios/pool-saturation";
import { postgresDisconnectScenario } from "../src/lib/resilience/scenarios/postgres-disconnect";
import { ssoDiscoveryOutageScenario } from "../src/lib/resilience/scenarios/sso-discovery-outage";
import { workerInterruptionScenario } from "../src/lib/resilience/scenarios/worker-interruption";

export type DrDrillOptions = {
  full: boolean;
  confirmNonProduction: string | null;
  jsonOutputPath: string | null;
};

export function parseArgs(argv: string[]): DrDrillOptions {
  const confirmFlag = argv.find((arg) =>
    arg.startsWith("--confirm-non-production=")
  );
  const jsonOutputFlag = argv.find((arg) => arg.startsWith("--json-output="));

  return {
    full: argv.includes("--full"),
    confirmNonProduction: confirmFlag ? confirmFlag.split("=", 2)[1]! : null,
    jsonOutputPath: jsonOutputFlag ? jsonOutputFlag.split("=", 2)[1]! : null
  };
}

/** The "safe" tier: every scenario here is fast, deterministic, and safe to run on every CI run. */
function buildSafeScenarios(): ScenarioDefinition[] {
  return [
    ssoDiscoveryOutageScenario(),
    poolSaturationScenario(),
    postgresDisconnectScenario(),
    workerInterruptionScenario(),
    emailProviderOutageScenario()
  ];
}

function buildScenarios(full: boolean): ScenarioDefinition[] {
  return full
    ? [...buildSafeScenarios(), backupRestoreDrillScenario()]
    : buildSafeScenarios();
}

export type DrReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  appEnv: string | null;
  tier: "safe" | "full";
  scenarios: ScenarioResult[];
  overall: ReturnType<typeof computeDrOverall>;
};

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
    console.error(`\ndr-drill: BLOCKED — ${authorization.reason}\n`);
    process.exitCode = 1;
    return;
  }

  if (!databaseUrl) {
    // Unreachable in practice (authorizeDrDrill already refuses an unset
    // DATABASE_URL via isProductionLikeTarget), kept only so TypeScript
    // can narrow the type below without a non-null assertion.
    console.error(
      "dr-drill: DATABASE_URL is unexpectedly unset after authorization."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `dr-drill: target acknowledged (APP_ENV="${appEnv}"). Running the ` +
      `${options.full ? "FULL" : "safe subset"} of scenarios.\n`
  );

  const startedAt = new Date();
  const scenarios = buildScenarios(options.full);
  const ctx: ScenarioContext = { databaseUrl, env: process.env };
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`=== dr-drill — ${scenario.name} (${scenario.tier}) ===`);
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

  const finishedAt = new Date();
  const overall = computeDrOverall(results);

  const report: DrReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    appEnv: appEnv ?? null,
    tier: options.full ? "full" : "safe",
    scenarios: results,
    overall
  };

  console.log("\n=== dr-drill — summary ===");
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
    await Bun.write(options.jsonOutputPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${options.jsonOutputPath}`);
  }

  if (overall !== "pass") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
