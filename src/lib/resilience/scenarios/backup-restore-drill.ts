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
import { join } from "node:path";

import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const RESTORE_DRILL_SCRIPT = join(
  REPO_ROOT,
  "deploy",
  "backup",
  "restore-drill.sh"
);
const DRILL_TARGET_DB = "awcms_mini_dr_drill";

function parseMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/(\d+)(?:\.\d+)*/);
  return match ? Number(match[1]) : undefined;
}

/** Same client/server major-version compatibility probe `backup-restore-drill.integration.test.ts` (Issue #691) already uses — pg_dump refuses to dump from a server newer than itself. */
function detectPgBinOverride(databaseUrl: string): {
  pathPrefix?: string;
  skipReason?: string;
} {
  const serverProbe = Bun.spawnSync([
    "psql",
    databaseUrl,
    "-tAc",
    "SHOW server_version_num"
  ]);
  const serverVersionRaw = Number(serverProbe.stdout.toString().trim());
  const serverMajor = Number.isFinite(serverVersionRaw)
    ? Math.floor(serverVersionRaw / 10000)
    : undefined;

  const clientProbe = Bun.spawnSync(["pg_dump", "--version"]);
  const clientMajor = parseMajorVersion(clientProbe.stdout.toString());

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
            DRILL_TARGET_DB
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
          await admin.unsafe(`DROP DATABASE IF EXISTS "${DRILL_TARGET_DB}"`);
        } finally {
          await admin.close({ timeout: 1 });
        }
      }
    }
  };
}
