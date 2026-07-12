/**
 * "backup-restore-drill" scenario (Issue #699, "full" tier only). Wraps
 * the EXISTING `deploy/backup/restore-drill.sh` (Issue #691) rather than
 * reimplementing backup/restore/verification — that script already does
 * backup -> restore into a disposable database -> verify schema-
 * migrations ledger + tenant isolation (RLS) + sample record -> RTO (wall
 * clock) / RPO (backup age) report. This scenario is the CLI glue that
 * runs it with ephemeral, drill-only keys and folds its report into the
 * DR run's own machine-readable output.
 *
 * "full" tier only (not run in the CI "safe" subset): needs a version-
 * matched `pg_dump`/`pg_restore` on PATH (same environment constraint
 * `tests/integration/backup-restore-drill.integration.test.ts` already
 * documents and works around) and takes noticeably longer than the other
 * scenarios (a real `pg_dump`/`pg_restore` round trip).
 *
 * Phases:
 * - Setup: detect a version-compatible `pg_dump`/`pg_restore` (skip, not
 *   fail, if unavailable — an environment constraint, not a DR-mechanism
 *   defect); generate ephemeral encryption/HMAC keys and a scratch
 *   backup directory (synthetic, drill-only credentials — never real
 *   production backup keys).
 * - Execute: run `restore-drill.sh` against a dedicated
 *   `awcms_mini_dr_drill` disposable database (distinct from the sh
 *   script's own default `awcms_mini_restore_drill`, so a scheduled
 *   cron-driven restore drill and this on-demand DR drill can never
 *   collide).
 * - Verify: the script's own JSON report `overall` field must be
 *   `"pass"` (schema_migrations AND tenant_isolation both genuinely
 *   passed, not skipped — see the script's own header comment for the
 *   full tri-state rationale, PR #708).
 * - Cleanup: remove the scratch backup dir, ephemeral keys, and the
 *   disposable `awcms_mini_dr_drill` database.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const RESTORE_DRILL_SCRIPT = join(
  REPO_ROOT,
  "deploy",
  "backup",
  "restore-drill.sh"
);
const DRILL_TARGET_DB_PREFIX = "awcms_mini_dr_drill";

function parseMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/(\d+)(?:\.\d+)*/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Splits a DATABASE_URL into the libpq `PG*` env vars `psql` reads
 * automatically — never as connection-string argv. Mirrors
 * `deploy/backup/backup-common.sh`'s `parse_database_url` (Issue #691):
 * a connection string passed as `psql`'s argv is readable via
 * `ps aux`/`/proc/<pid>/cmdline` to any user on a shared host for the
 * process's lifetime, while env vars are only visible via
 * `/proc/<pid>/environ` to the same user or root — a materially
 * narrower exposure (security-auditor/reviewer finding on PR #716's
 * original `psql databaseUrl -tAc ...` form).
 */
function databaseUrlToPgEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);

  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, ""))
  };
}

/**
 * Runs `Bun.spawnSync` and returns `null` (never throws) if the binary
 * itself is entirely missing from PATH. Reviewer finding on PR #716:
 * `Bun.spawnSync` THROWS (`"Executable not found in $PATH"`), it does not
 * return a failed result, for a fully-absent binary — that throw was
 * previously uncaught here, escaping to `runScenario`'s generic catch and
 * turning a plain "not installed" environment constraint into a hard
 * `"fail"`, contradicting this scenario's own documented "skip, not fail,
 * if unavailable" contract.
 */
function trySpawnSync(
  ...args: Parameters<typeof Bun.spawnSync>
): ReturnType<typeof Bun.spawnSync> | null {
  try {
    return Bun.spawnSync(...args);
  } catch {
    return null;
  }
}

/** Same client/server major-version compatibility probe `backup-restore-drill.integration.test.ts` (Issue #691) already uses — pg_dump refuses to dump from a server newer than itself. */
function detectPgBinOverride(databaseUrl: string): {
  pathPrefix?: string;
  skipReason?: string;
} {
  const serverProbe = trySpawnSync(
    ["psql", "-tAc", "SHOW server_version_num"],
    {
      env: { ...process.env, ...databaseUrlToPgEnv(databaseUrl) }
    }
  );

  if (!serverProbe) {
    return { skipReason: "psql is not installed / not found on PATH" };
  }

  const serverVersionRaw = Number(
    (serverProbe.stdout?.toString() ?? "").trim()
  );
  const serverMajor = Number.isFinite(serverVersionRaw)
    ? Math.floor(serverVersionRaw / 10000)
    : undefined;

  const clientProbe = trySpawnSync(["pg_dump", "--version"]);

  if (!clientProbe) {
    return { skipReason: "pg_dump is not installed / not found on PATH" };
  }

  if (!existsSync(join(dirname(Bun.which("pg_dump") ?? ""), "pg_restore"))) {
    return {
      skipReason:
        "pg_restore is not installed / not found alongside pg_dump on PATH"
    };
  }

  const clientMajor = parseMajorVersion(clientProbe.stdout?.toString() ?? "");

  if (serverMajor === undefined || clientMajor === undefined) {
    return {
      skipReason: "could not determine pg_dump client or server major version"
    };
  }

  if (clientMajor >= serverMajor) {
    return {};
  }

  const candidate = `/usr/lib/postgresql/${serverMajor}/bin`;

  if (
    existsSync(join(candidate, "pg_dump")) &&
    existsSync(join(candidate, "pg_restore"))
  ) {
    return { pathPrefix: candidate };
  }

  return {
    skipReason:
      `pg_dump client (major ${clientMajor}) is older than the server ` +
      `(major ${serverMajor}) and no matching client binaries were found ` +
      `at ${candidate}.`
  };
}

export function backupRestoreDrillScenario(): ScenarioDefinition {
  return {
    name: "backup-restore-drill",
    tier: "full",
    timeoutMs: 120_000,
    async run(ctx): Promise<ScenarioOutcome> {
      // Setup.
      const { pathPrefix, skipReason } = detectPgBinOverride(ctx.databaseUrl);

      if (skipReason) {
        return {
          ok: true,
          skipped: true,
          detail: `Skipped — ${skipReason} (environment constraint, not a DR-mechanism defect).`
        };
      }

      const backupDir = mkdtempSync(join(tmpdir(), "awcms-mini-dr-drill-"));
      const keyDir = mkdtempSync(join(tmpdir(), "awcms-mini-dr-drill-keys-"));
      const encKeyFile = join(keyDir, "enc.key");
      const hmacKeyFile = join(keyDir, "hmac.key");
      writeFileSync(encKeyFile, randomBytes(32).toString("base64"));
      writeFileSync(hmacKeyFile, randomBytes(32).toString("base64"));

      // Per-run-unique target DB name (reviewer finding on PR #716): a
      // fixed name let two concurrent --full drills against the same
      // cluster race on the same disposable database's create/restore/
      // verify/drop lifecycle, producing false DR evidence or spurious
      // failures — exactly the risk this run is supposed to measure
      // reliably.
      const drillTargetDb = `${DRILL_TARGET_DB_PREFIX}_${randomBytes(4).toString("hex")}`;

      try {
        const path = pathPrefix
          ? `${pathPrefix}:${process.env.PATH ?? ""}`
          : (process.env.PATH ?? "");

        // Execute.
        const proc = Bun.spawnSync([RESTORE_DRILL_SCRIPT], {
          env: {
            PATH: path,
            DATABASE_URL: ctx.databaseUrl,
            BACKUP_DIR: backupDir,
            BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
            BACKUP_HMAC_KEY_FILE: hmacKeyFile,
            DRILL_TARGET_DB: drillTargetDb
          },
          stdout: "pipe",
          stderr: "pipe"
        });

        const stdout = proc.stdout.toString();
        const stderr = proc.stderr.toString();

        const glob = new Bun.Glob("restore-drill-*.json");
        const [reportFile] = [...glob.scanSync({ cwd: backupDir })];

        if (!reportFile) {
          return {
            ok: false,
            detail:
              `restore-drill.sh produced no report file (exitCode=${proc.exitCode}). ` +
              `stdout tail: ${stdout.slice(-500)} stderr tail: ${stderr.slice(-500)}`
          };
        }

        const report = JSON.parse(
          await Bun.file(join(backupDir, reportFile)).text()
        ) as {
          overall: "pass" | "incomplete" | "fail";
          duration_seconds: number;
          backup_age_seconds: number | string;
        };

        // Verify.
        return {
          ok: report.overall === "pass",
          detail: `restore-drill.sh overall="${report.overall}" (RTO proxy ${report.duration_seconds}s, RPO proxy backup_age=${report.backup_age_seconds}s).`,
          metrics: {
            restoreRtoSeconds: report.duration_seconds,
            restoreRpoSeconds:
              typeof report.backup_age_seconds === "number"
                ? report.backup_age_seconds
                : -1
          }
        };
      } finally {
        // Cleanup.
        rmSync(backupDir, { recursive: true, force: true });
        rmSync(keyDir, { recursive: true, force: true });

        const admin = new Bun.SQL(ctx.databaseUrl, { max: 1 });
        try {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${drillTargetDb}"`);
        } finally {
          await admin.close({ timeout: 1 });
        }
      }
    }
  };
}
