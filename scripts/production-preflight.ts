/**
 * production-preflight.ts — `bun run production:preflight`.
 *
 * Issue 10.3 (doc 07 §Production readiness checklist, skill
 * `awcms-mini-production-preflight`), reworked by Issue #684 (epic #679,
 * platform-hardening) to be non-destructive by default.
 *
 * PRIOR BEHAVIOR (the bug this issue fixes): `db:migrate` ran unconditionally
 * as an early stage, before `api:spec:check`/`test`/`build`. A later stage
 * failing therefore still left the target database mutated by a preflight
 * run whose own final verdict was "GO-LIVE DIBLOKIR" — a "preflight" that
 * mutates its target even when it blocks go-live is not actually safe to
 * run repeatedly, which defeats the entire point of a preflight.
 *
 * NEW ORDER — every stage below is READ-ONLY (matches the issue's own
 * required ordering: config/security, connectivity + read-only schema
 * inspection, specs/contracts, tests/build, migration plan, then optional
 * apply):
 *
 *   1. config:validate       — config must be valid before anything else
 *                               attempts to connect to a database.
 *   2. security:readiness
 *   3. db:connectivity        (NEW) — confirms DATABASE_URL is reachable
 *                               and the migration ledger table is
 *                               queryable. Issues exactly one `SELECT`,
 *                               never a write.
 *   4. api:spec:check
 *   5. test
 *   6. build
 *   7. db:pool:health          — needs a running server; skipped (not
 *                               failed) if nothing answers, UNLESS
 *                               `APP_ENV=production`, in which case a skip
 *                               now blocks go-live (a production preflight
 *                               that can't reach a running instance's pool
 *                               metrics has not actually verified
 *                               production readiness).
 *   8. migration:plan          (NEW) — the actual pending-vs-applied diff,
 *                               deliberately placed as the LAST read-only
 *                               step, immediately before the decision to
 *                               apply. Still zero writes: reuses
 *                               `discoverMigrationFiles`/
 *                               `validateAppliedChecksums` from
 *                               `db-migrate.ts` (the same checksum-mismatch
 *                               guard the real migration run uses) against
 *                               a read-only `SELECT` of the ledger table.
 *
 * APPLYING MIGRATIONS is now a separate, explicit, gated step — never part
 * of the stage list above:
 *
 *   - Only attempted if `go` (the verdict after all 8 stages) is `true`.
 *     A failed quality gate — or, in `APP_ENV=production`, a skipped
 *     `db:pool:health` — makes it structurally impossible to reach the
 *     apply step, regardless of flags (`shouldApplyMigrations`'s caller,
 *     `authorizeApply`, is the pure function this invariant lives in,
 *     unit-tested directly).
 *   - Requires `--apply-migrations` (the operator's intent to mutate).
 *   - Requires `--backup-verified` (attests a recent, restorable backup
 *     exists — see `docs/awcms-mini/production-preflight-runbook.md`).
 *   - Requires `--acknowledge-target=<value>` where `<value>` matches
 *     `APP_ENV` exactly — a deliberate typo-catcher: an operator who runs
 *     this against the wrong environment (wrong shell, wrong `.env`) with
 *     the wrong `--acknowledge-target` value gets a hard refusal instead
 *     of a silent mutation of the wrong database.
 *   - `--json-output=<path>` (optional, either mode) writes the full
 *     structured `{ go, failedStages, blockingSkips, results, plan, applied }` result to a file — the
 *     "structured machine-readable result" the issue's scope asks for,
 *     without changing the default human-readable stdout output anyone
 *     already depends on.
 */
import {
  discoverMigrationFiles,
  redactDatabaseUrl,
  validateAppliedChecksums,
  type AppliedMigration,
  type MigrationFile
} from "./db-migrate";
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

const REMAINING_CHILD_PROCESS_STAGES: StageDefinition[] = [
  { name: "api:spec:check", command: ["bun", "run", "api:spec:check"] },
  // Issue #740 (epic #738) security follow-up (PR #769 security-auditor
  // review): a derived repository's own production deployment is exactly
  // the scenario where build-time module composition could be invalid
  // (e.g. an application module colliding with a base module's key) — a
  // production preflight that never checks this would go live without
  // ever having verified it. Read-only, no I/O beyond the in-memory
  // registry (same as `modules:dag:check`, which this is a superset of),
  // fits this stage list's "every stage is read-only" requirement exactly.
  {
    name: "modules:compose:check",
    command: ["bun", "run", "modules:compose:check"]
  },
  // Issue #741 (epic #738), same reasoning as `modules:compose:check`
  // immediately above (and the exact same PR #769 security-auditor
  // finding this repeats the fix for): a derived repository's own
  // production preflight is precisely where an incompatible declared
  // AWCMS-Mini range, module-contract version, capability version, or an
  // edited historical migration checksum must be caught — read-only
  // (manifest/migration-file/contract-file reads only, no writes), no
  // database required (a base-repo run with no committed manifest passes
  // trivially, same as `modules:compose:check` does with no application
  // registry).
  {
    name: "extension:check",
    command: ["bun", "run", "extension:check"]
  },
  { name: "test", command: ["bun", "test"] },
  { name: "build", command: ["bun", "run", "build"] }
  // db:connectivity, db:pool:health, and migration:plan are handled
  // separately below — each needs custom logic (a direct read-only DB
  // query, a reachability probe, or both), not a plain child-process spawn.
];

/** Stages whose SKIP status blocks go-live specifically when APP_ENV=production. */
const MANDATORY_IN_PRODUCTION = new Set(["db:pool:health"]);

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

function getDatabaseUrlForReadOnlyCheck(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl && databaseUrl.startsWith("postgres://")
    ? databaseUrl
    : null;
}

/**
 * Read-only: a single `SELECT` confirming the database is reachable and
 * the migration ledger table exists and is queryable. Never issues DDL/DML
 * — `to_regclass` is a catalog lookup, not a table-creating call (unlike
 * `db-migrate.ts`'s own `CREATE TABLE IF NOT EXISTS` bootstrap, which this
 * deliberately does NOT run, since that would itself be a mutation).
 */
async function checkDatabaseConnectivity(): Promise<StageResult> {
  const start = performance.now();
  console.log(`\n=== production:preflight — db:connectivity ===`);

  const databaseUrl = getDatabaseUrlForReadOnlyCheck();

  if (!databaseUrl) {
    const detail = "DATABASE_URL is not set or does not use postgres://";
    console.log(`FAIL — ${detail}`);
    return {
      name: "db:connectivity",
      status: "fail",
      detail,
      durationMs: performance.now() - start
    };
  }

  let sql: Bun.SQL | undefined;

  try {
    sql = new Bun.SQL(databaseUrl, { max: 1 });
    const rows =
      await sql`SELECT to_regclass('public.awcms_mini_schema_migrations') AS reg`;
    const ledgerExists = Boolean(rows[0]?.reg);
    console.log(
      `PASS — database reachable` +
        (ledgerExists
          ? "; migration ledger table found."
          : "; migration ledger table not found yet (expected on a brand-new database).")
    );
    return {
      name: "db:connectivity",
      status: "pass",
      durationMs: performance.now() - start
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const detail = redactDatabaseUrl(rawMessage, databaseUrl);
    console.log(`FAIL — ${detail}`);
    return {
      name: "db:connectivity",
      status: "fail",
      detail,
      durationMs: performance.now() - start
    };
  } finally {
    await sql?.close({ timeout: 1 });
  }
}

export type MigrationPlan = {
  pending: string[];
  appliedCount: number;
};

/** Pure diff — no I/O — so the "what would apply" logic is unit-testable without a database. */
export function computeMigrationPlan(
  migrations: MigrationFile[],
  appliedRows: AppliedMigration[]
): MigrationPlan {
  validateAppliedChecksums(migrations, appliedRows);

  const appliedNames = new Set(appliedRows.map((row) => row.migration_name));
  const pending = migrations
    .filter((migration) => !appliedNames.has(migration.name))
    .map((migration) => migration.name);

  return { pending, appliedCount: appliedNames.size };
}

/**
 * Read-only dry-run: discovers local migration files and reads (never
 * writes) the ledger table to report exactly what `bun run db:migrate`
 * would apply — reuses `validateAppliedChecksums`, the same checksum-
 * mismatch guard the real migration run uses, so a tampered/edited
 * already-applied migration is caught here too, before any apply attempt.
 */
async function planMigrations(): Promise<
  StageResult & { plan?: MigrationPlan }
> {
  const start = performance.now();
  console.log(`\n=== production:preflight — migration:plan ===`);

  const databaseUrl = getDatabaseUrlForReadOnlyCheck();

  if (!databaseUrl) {
    const detail = "DATABASE_URL is not set or does not use postgres://";
    console.log(`FAIL — ${detail}`);
    return {
      name: "migration:plan",
      status: "fail",
      detail,
      durationMs: performance.now() - start
    };
  }

  let sql: Bun.SQL | undefined;

  try {
    const migrations = await discoverMigrationFiles();
    sql = new Bun.SQL(databaseUrl, { max: 1 });

    const tableCheck =
      await sql`SELECT to_regclass('public.awcms_mini_schema_migrations') AS reg`;
    const appliedRows = tableCheck[0]?.reg
      ? ((await sql`
          SELECT migration_name, checksum FROM awcms_mini_schema_migrations
          ORDER BY migration_name ASC
        `) as AppliedMigration[])
      : [];

    const plan = computeMigrationPlan(migrations, appliedRows);

    console.log(
      `migration:plan — ${plan.pending.length} pending, ${plan.appliedCount} already applied.`
    );
    if (plan.pending.length > 0) {
      console.log(`  pending: ${plan.pending.join(", ")}`);
    }

    return {
      name: "migration:plan",
      status: "pass",
      detail: `${plan.pending.length} pending`,
      durationMs: performance.now() - start,
      plan
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const detail = redactDatabaseUrl(rawMessage, databaseUrl);
    console.log(`FAIL — ${detail}`);
    return {
      name: "migration:plan",
      status: "fail",
      detail,
      durationMs: performance.now() - start
    };
  } finally {
    await sql?.close({ timeout: 1 });
  }
}

export async function runProductionPreflight(): Promise<{
  results: StageResult[];
  plan?: MigrationPlan;
}> {
  const results: StageResult[] = [];

  results.push(
    await runStage("config:validate", ["bun", "run", "config:validate"])
  );
  results.push(
    await runStage("security:readiness", ["bun", "run", "security:readiness"])
  );
  results.push(await checkDatabaseConnectivity());

  for (const stage of REMAINING_CHILD_PROCESS_STAGES) {
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

  const planResult = await planMigrations();
  results.push({
    name: planResult.name,
    status: planResult.status,
    detail: planResult.detail,
    durationMs: planResult.durationMs
  });

  return { results, plan: planResult.plan };
}

export type Verdict = {
  go: boolean;
  failedStages: string[];
  blockingSkips: string[];
};

/**
 * Pure — no I/O — so the production-profile blocking-skip rule is directly
 * unit-testable. `appEnv` is threaded in explicitly rather than read from
 * `process.env` here, for the same testability reason.
 */
export function computeVerdict(
  results: StageResult[],
  appEnv: string | undefined
): Verdict {
  const failedStages = results
    .filter((result) => result.status === "fail")
    .map((result) => result.name);

  const blockingSkips =
    appEnv === "production"
      ? results
          .filter(
            (result) =>
              result.status === "skipped" &&
              MANDATORY_IN_PRODUCTION.has(result.name)
          )
          .map((result) => result.name)
      : [];

  return {
    go: failedStages.length === 0 && blockingSkips.length === 0,
    failedStages,
    blockingSkips
  };
}

function printVerdict(verdict: Verdict, results: StageResult[]): void {
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

  console.log("");

  if (!verdict.go) {
    console.log("GO-LIVE DIBLOKIR");
    if (verdict.failedStages.length > 0) {
      console.log(`Failed stage(s): ${verdict.failedStages.join(", ")}.`);
    }
    if (verdict.blockingSkips.length > 0) {
      console.log(
        `APP_ENV=production requires these stages to actually run, not skip: ${verdict.blockingSkips.join(", ")}.`
      );
    }
    return;
  }

  console.log("GO-LIVE DIIZINKAN");
}

export type PreflightOptions = {
  applyMigrations: boolean;
  backupVerified: boolean;
  acknowledgeTarget: string | null;
  jsonOutputPath: string | null;
};

export function parseArgs(argv: string[]): PreflightOptions {
  const acknowledgeFlag = argv.find((arg) =>
    arg.startsWith("--acknowledge-target=")
  );
  const jsonOutputFlag = argv.find((arg) => arg.startsWith("--json-output="));

  return {
    applyMigrations: argv.includes("--apply-migrations"),
    backupVerified: argv.includes("--backup-verified"),
    acknowledgeTarget: acknowledgeFlag
      ? acknowledgeFlag.split("=", 2)[1]!
      : null,
    jsonOutputPath: jsonOutputFlag ? jsonOutputFlag.split("=", 2)[1]! : null
  };
}

/**
 * Pure gate — the single place `--apply-migrations` is allowed to turn
 * into an actual mutation. `go: false` (any failed stage, or a blocking
 * production skip) short-circuits before backup/target checks even run —
 * a failed quality gate is reason enough on its own, independent of what
 * flags were passed (issue acceptance criterion: "Failed quality gates
 * never apply migrations").
 */
export function authorizeApply(
  go: boolean,
  options: PreflightOptions,
  appEnv: string | undefined
): { ok: true } | { ok: false; reason: string } {
  if (!go) {
    return {
      ok: false,
      reason:
        "Earlier stage(s) failed or were blocked — migrations were not applied."
    };
  }

  if (!options.applyMigrations) {
    return {
      ok: false,
      reason:
        "Migrations were not applied (pass --apply-migrations to apply; see migration:plan above for what would run)."
    };
  }

  if (!options.backupVerified) {
    return {
      ok: false,
      reason:
        "--apply-migrations requires --backup-verified (confirm a recent, restorable backup exists first — see docs/awcms-mini/production-preflight-runbook.md)."
    };
  }

  if (!options.acknowledgeTarget) {
    return {
      ok: false,
      reason:
        "--apply-migrations requires --acknowledge-target=<APP_ENV value> to confirm the operator knows which environment is being mutated."
    };
  }

  if (options.acknowledgeTarget !== appEnv) {
    return {
      ok: false,
      reason: `--acknowledge-target="${options.acknowledgeTarget}" does not match APP_ENV="${appEnv ?? ""}". Refusing to apply migrations against a target you have not explicitly acknowledged.`
    };
  }

  return { ok: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { results, plan } = await runProductionPreflight();
  const verdict = computeVerdict(results, process.env.APP_ENV);

  printVerdict(verdict, results);

  const authorization = authorizeApply(
    verdict.go,
    options,
    process.env.APP_ENV
  );
  let applyResult: StageResult | null = null;

  if (authorization.ok) {
    console.log(
      `\n=== production:preflight — applying ${plan?.pending.length ?? 0} migration(s) ===`
    );
    applyResult = await runStage("db:migrate (apply)", [
      "bun",
      "run",
      "db:migrate"
    ]);
    console.log(
      applyResult.status === "pass"
        ? "Migrations applied."
        : `Migration apply FAILED — ${applyResult.detail}.`
    );
  } else {
    console.log(`\n${authorization.reason}`);
  }

  if (options.jsonOutputPath) {
    await Bun.write(
      options.jsonOutputPath,
      JSON.stringify(
        {
          go: verdict.go,
          failedStages: verdict.failedStages,
          blockingSkips: verdict.blockingSkips,
          results,
          plan,
          applied: applyResult
            ? { status: applyResult.status, detail: applyResult.detail }
            : null
        },
        null,
        2
      )
    );
  }

  if (!verdict.go || applyResult?.status === "fail") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
