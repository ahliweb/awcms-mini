/**
 * production-preflight.ts — `bun run production:preflight`.
 *
 * Issue 10.3 (doc 07 §Production readiness checklist, skill
 * `awcms-mini-production-preflight`). Orchestrates the preflight command
 * list from the skill, in order, as child processes, and prints a final
 * aggregated go/no-go verdict:
 *
 *   bun run config:validate  (Issue 12.2 — runs first; config must be
 *                             valid before anything else attempts to
 *                             connect to a database or run migrations)
 *   bun run db:migrate
 *   bun run api:spec:check
 *   bun test
 *   bun run build
 *   bun run db:pool:health   (only if a server is actually reachable)
 *   bun run security:readiness
 *
 * `bun install` from the skill's command list is deliberately NOT run here
 * — it's an environment-setup step (fetching dependencies), not a readiness
 * check, and is outside this script's concern.
 *
 * `db:pool:health` requires a running HTTP server, which a CI/preflight run
 * may not have. Rather than block the entire preflight on that one stage,
 * this script first probes `GET /api/v1/health` (via
 * `scripts/lib/app-url.ts`'s `isServerReachable`) and, if nothing answers,
 * records that stage as "skipped" (not a failure) with a clear reason —
 * this is a deliberate design choice, not an oversight.
 *
 * Every other stage runs regardless of earlier failures, so a single broken
 * stage doesn't hide problems in later ones — the final report lists every
 * stage that failed, not just the first.
 */
import { isServerReachable, resolveAppBaseUrl } from "./lib/app-url";

export type StageStatus = "pass" | "fail" | "skipped";

export type StageResult = {
  name: string;
  status: StageStatus;
  detail?: string;
  durationMs: number;
};

type StageDefinition = {
  name: string;
  command: string[];
};

const STAGES: StageDefinition[] = [
  { name: "config:validate", command: ["bun", "run", "config:validate"] },
  { name: "db:migrate", command: ["bun", "run", "db:migrate"] },
  { name: "api:spec:check", command: ["bun", "run", "api:spec:check"] },
  { name: "test", command: ["bun", "test"] },
  { name: "build", command: ["bun", "run", "build"] }
  // db:pool:health and security:readiness are handled separately below —
  // db:pool:health needs the reachability probe, security:readiness always
  // runs last so its report reflects the state after build/migrate.
];

async function runStage(name: string, command: string[]): Promise<StageResult> {
  const start = performance.now();
  console.log(`\n=== production:preflight — ${name} ===`);

  const proc = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await proc.exited;
  const durationMs = performance.now() - start;

  return {
    name,
    status: exitCode === 0 ? "pass" : "fail",
    detail: exitCode === 0 ? undefined : `exit code ${exitCode}`,
    durationMs
  };
}

export async function runProductionPreflight(): Promise<StageResult[]> {
  const results: StageResult[] = [];

  for (const stage of STAGES) {
    results.push(await runStage(stage.name, stage.command));
  }

  const baseUrl = resolveAppBaseUrl();
  const reachable = await isServerReachable(baseUrl);

  if (reachable) {
    results.push(
      await runStage("db:pool:health", ["bun", "run", "db:pool:health"])
    );
  } else {
    console.log(`\n=== production:preflight — db:pool:health ===`);
    console.log(
      `skipped — no server reachable at ${baseUrl}. Start the server ` +
        "(`bun run preview` after `bun run build`, or `bun run dev`) to include this stage."
    );
    results.push({
      name: "db:pool:health",
      status: "skipped",
      detail: `no server reachable at ${baseUrl}`,
      durationMs: 0
    });
  }

  results.push(
    await runStage("security:readiness", ["bun", "run", "security:readiness"])
  );

  return results;
}

function printVerdict(results: StageResult[]): boolean {
  console.log("\n=== production:preflight — summary ===");

  for (const result of results) {
    const label =
      result.status === "pass"
        ? "PASS"
        : result.status === "skipped"
          ? "SKIP"
          : "FAIL";
    const suffix = result.detail ? ` (${result.detail})` : "";
    console.log(`[${label}] ${result.name}${suffix}`);
  }

  const failed = results.filter((result) => result.status === "fail");

  console.log("");

  if (failed.length > 0) {
    console.log("GO-LIVE DIBLOKIR");
    console.log(
      `Failed stage(s): ${failed.map((result) => result.name).join(", ")}.`
    );
    return false;
  }

  console.log("GO-LIVE DIIZINKAN");
  return true;
}

async function main() {
  const results = await runProductionPreflight();
  const go = printVerdict(results);

  if (!go) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
