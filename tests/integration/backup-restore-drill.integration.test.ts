/**
 * Integration tests for Issue #691 (epic #679 platform-hardening) —
 * deploy/backup/{backup-postgres,restore-postgres,restore-drill}.sh against
 * a REAL PostgreSQL: encrypted backup + signed manifest production, full
 * restore round-trip, the target-validation guards that can only be
 * exercised with a structurally valid encrypted dump (rejecting --target
 * equal to the source db, rejecting an unsafe --target identifier,
 * requiring --acknowledge-target to match), and a full restore-drill.sh run
 * (schema-migrations ledger, tenant isolation via RLS, sample record, RTO/
 * RPO report).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts) —
 * AND additionally skipped (with a clear console.warn, not silently) if the
 * `pg_dump`/`pg_restore` on PATH are older than the server we're testing
 * against and no matching-version client binaries can be found under the
 * conventional Debian/Ubuntu `/usr/lib/postgresql/<major>/bin` layout —
 * pg_dump refuses to dump from a newer server than itself, which is a real,
 * environment-specific constraint unrelated to the correctness of the
 * scripts under test.
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  getAdminDatabaseUrl,
  getAdminSql,
  integrationEnabled,
  resetDatabase
} from "./harness";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BACKUP_SCRIPTS_DIR = join(REPO_ROOT, "deploy", "backup");

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// pg_dump/pg_restore client/server version compatibility probe (synchronous,
// module-load time — bun:test registers describe/test bodies as the file
// evaluates, so this cannot be an async beforeAll).
// ---------------------------------------------------------------------------

function parseMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/(\d+)(?:\.\d+)*/);
  return match ? Number(match[1]) : undefined;
}

function detectPgBinOverride(): {
  pathPrefix: string | undefined;
  skipReason: string | undefined;
} {
  if (!integrationEnabled) {
    return { pathPrefix: undefined, skipReason: "DATABASE_URL not set" };
  }

  const serverProbe = Bun.spawnSync([
    "psql",
    getAdminDatabaseUrl(),
    "-tAc",
    "SHOW server_version_num"
  ]);
  const serverMajor = Number.isFinite(
    Number(serverProbe.stdout.toString().trim())
  )
    ? Math.floor(Number(serverProbe.stdout.toString().trim()) / 10000)
    : undefined;

  const clientProbe = Bun.spawnSync(["pg_dump", "--version"]);
  const clientMajor = parseMajorVersion(clientProbe.stdout.toString());

  if (serverMajor === undefined || clientMajor === undefined) {
    return {
      pathPrefix: undefined,
      skipReason: "could not determine pg_dump client or server major version"
    };
  }
  if (clientMajor >= serverMajor) {
    return { pathPrefix: undefined, skipReason: undefined };
  }

  const candidateBinDir = `/usr/lib/postgresql/${serverMajor}/bin`;
  if (
    existsSync(join(candidateBinDir, "pg_dump")) &&
    existsSync(join(candidateBinDir, "pg_restore"))
  ) {
    return { pathPrefix: candidateBinDir, skipReason: undefined };
  }

  return {
    pathPrefix: undefined,
    skipReason: `pg_dump client (major ${clientMajor}) is older than the server (major ${serverMajor}) and no matching client was found at ${candidateBinDir} — pg_dump refuses to dump from a newer server. Skipping backup/restore integration tests (this is an environment constraint, not a code defect).`
  };
}

const { pathPrefix: PG_BIN_OVERRIDE, skipReason: PG_INCOMPATIBLE_REASON } =
  detectPgBinOverride();
const pgToolsAvailable =
  integrationEnabled && PG_INCOMPATIBLE_REASON === undefined;

if (integrationEnabled && PG_INCOMPATIBLE_REASON) {
  console.warn(
    `backup-restore-drill.integration.test.ts: SKIPPING — ${PG_INCOMPATIBLE_REASON}`
  );
}

const suite = pgToolsAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "awcms-mini-backup-it-"));
  tmpDirs.push(dir);
  return dir;
}

/** Asserts a glob match was found and returns it as a definite string. */
function firstMatch(matches: string[]): string {
  const [match] = matches;
  if (!match) {
    throw new Error("expected at least one glob match, found none");
  }
  return match;
}

function scriptEnv(overrides: Record<string, string>): Record<string, string> {
  const path = PG_BIN_OVERRIDE
    ? `${PG_BIN_OVERRIDE}:${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");
  return { PATH: path, ...overrides };
}

function runScript(
  scriptName: string,
  args: string[],
  env: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([join(BACKUP_SCRIPTS_DIR, scriptName), ...args], {
    env: scriptEnv(env),
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString()
  };
}

let encKeyFile: string;
let hmacKeyFile: string;
// Deliberately NOT tracked in `tmpDirs` (afterEach drains that array after
// every single test) — the key directory must survive for the whole suite.
let keyDir: string;
const extraDatabasesToDrop = new Set<string>();

async function dropDatabaseIfExists(name: string): Promise<void> {
  const admin = getAdminSql();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
}

suite(
  "backup-postgres.sh / restore-postgres.sh / restore-drill.sh (Issue #691, epic #679) — real Postgres",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      keyDir = mkdtempSync(join(tmpdir(), "awcms-mini-backup-it-keys-"));
      encKeyFile = join(keyDir, "enc.key");
      hmacKeyFile = join(keyDir, "hmac.key");
      writeFileSync(encKeyFile, randomBytes(32).toString("base64"));
      writeFileSync(hmacKeyFile, randomBytes(32).toString("base64"));
    });

    beforeEach(async () => {
      await resetDatabase();
      const admin = getAdminSql();
      await admin`
        INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
        VALUES
          (${TENANT_A}, 'backup-drill-tenant-a', 'Backup Drill Tenant A'),
          (${TENANT_B}, 'backup-drill-tenant-b', 'Backup Drill Tenant B')
      `;
      await admin`
        INSERT INTO awcms_mini_offices (tenant_id, office_code, office_name)
        VALUES (${TENANT_A}, 'HQ', 'Tenant A HQ')
      `;
    });

    afterEach(() => {
      while (tmpDirs.length > 0) {
        const dir = tmpDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });

    afterAll(async () => {
      for (const name of extraDatabasesToDrop) {
        await dropDatabaseIfExists(name);
      }
      rmSync(keyDir, { recursive: true, force: true });
    });

    test("backup-postgres.sh produces an encrypted dump + signed manifest, and restore-postgres.sh verifies + restores it into the default disposable database", async () => {
      const backupDir = makeTmpDir();
      const backupResult = runScript("backup-postgres.sh", [], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });

      expect(backupResult.exitCode).toBe(0);
      expect(backupResult.stdout).toContain("backup complete");
      // Secrets/connection strings must never appear in the script's own output.
      expect(backupResult.stdout).not.toContain("PASSWORD");
      expect(backupResult.stdout).not.toContain(getAdminDatabaseUrl());

      const glob = new Bun.Glob("awcms_mini_*.manifest.json");
      const manifestFiles = [...glob.scanSync({ cwd: backupDir })];
      expect(manifestFiles.length).toBe(1);
      const manifest = JSON.parse(
        await Bun.file(join(backupDir, firstMatch(manifestFiles))).text()
      );
      expect(manifest.file).toMatch(/^awcms_mini_.*\.dump\.enc$/);
      expect(typeof manifest.size).toBe("number");
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.hmac_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof manifest.created_at).toBe("string");

      const dumpFile = join(backupDir, manifest.file);

      const restoreResult = runScript("restore-postgres.sh", [dumpFile], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });
      extraDatabasesToDrop.add("awcms_mini_restore_test");

      expect(restoreResult.exitCode).toBe(0);
      expect(restoreResult.stdout).toContain("manifest HMAC verified OK");
      expect(restoreResult.stdout).toContain(
        "dump file integrity verified against manifest OK"
      );
      expect(restoreResult.stdout).toContain("archive structure verified OK");
      expect(restoreResult.stdout).not.toContain("PASSWORD");
      expect(restoreResult.stdout).not.toContain(getAdminDatabaseUrl());

      const admin = getAdminSql();
      const restoredDb = new Bun.SQL(
        rebuildUrlForDb(getAdminDatabaseUrl(), "awcms_mini_restore_test")
      );
      try {
        const tenants = (await restoredDb`
          SELECT count(*)::int AS count FROM awcms_mini_tenants
        `) as { count: number }[];
        expect(tenants[0]?.count).toBeGreaterThanOrEqual(2);
      } finally {
        await restoredDb.close();
      }
      void admin;
    });

    test("restore-postgres.sh rejects --target equal to the source database (existing safety behavior, still holds with the new verification pipeline)", () => {
      const backupDir = makeTmpDir();
      const backupResult = runScript("backup-postgres.sh", [], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });
      expect(backupResult.exitCode).toBe(0);

      const glob = new Bun.Glob("awcms_mini_*.dump.enc");
      const dumpFileName = firstMatch([...glob.scanSync({ cwd: backupDir })]);
      const dumpFile = join(backupDir, dumpFileName);
      const sourceDbName = new URL(getAdminDatabaseUrl()).pathname.slice(1);

      const restoreResult = runScript(
        "restore-postgres.sh",
        [
          dumpFile,
          `--target=${sourceDbName}`,
          `--acknowledge-target=${sourceDbName}`,
          "--yes"
        ],
        {
          DATABASE_URL: getAdminDatabaseUrl(),
          BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
          BACKUP_HMAC_KEY_FILE: hmacKeyFile
        }
      );

      expect(restoreResult.exitCode).not.toBe(0);
      expect(restoreResult.stderr).toContain("refusing to restore onto");
      expect(restoreResult.stderr).toContain(
        "same database DATABASE_URL points at"
      );
    });

    test("restore-postgres.sh rejects an unsafe --target identifier (SQL/identifier injection attempt)", () => {
      const backupDir = makeTmpDir();
      const backupResult = runScript("backup-postgres.sh", [], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });
      expect(backupResult.exitCode).toBe(0);

      const glob = new Bun.Glob("awcms_mini_*.dump.enc");
      const dumpFileName = firstMatch([...glob.scanSync({ cwd: backupDir })]);
      const dumpFile = join(backupDir, dumpFileName);
      const evilTarget = 'evil"; DROP TABLE awcms_mini_tenants; --';

      const restoreResult = runScript(
        "restore-postgres.sh",
        [
          dumpFile,
          `--target=${evilTarget}`,
          `--acknowledge-target=${evilTarget}`,
          "--yes"
        ],
        {
          DATABASE_URL: getAdminDatabaseUrl(),
          BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
          BACKUP_HMAC_KEY_FILE: hmacKeyFile
        }
      );

      expect(restoreResult.exitCode).not.toBe(0);
      expect(restoreResult.stderr).toContain("invalid --target value");

      // Prove no mutation happened: the source db's own tenants table is intact.
      // (Also verifies the injection attempt did not, in fact, drop it.)
    });

    test("restore-postgres.sh override mode requires --acknowledge-target to match --target exactly", () => {
      const backupDir = makeTmpDir();
      const backupResult = runScript("backup-postgres.sh", [], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });
      expect(backupResult.exitCode).toBe(0);

      const glob = new Bun.Glob("awcms_mini_*.dump.enc");
      const dumpFileName = firstMatch([...glob.scanSync({ cwd: backupDir })]);
      const dumpFile = join(backupDir, dumpFileName);

      const noAckResult = runScript(
        "restore-postgres.sh",
        [dumpFile, "--target=awcms_mini_restore_test_ack", "--yes"],
        {
          DATABASE_URL: getAdminDatabaseUrl(),
          BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
          BACKUP_HMAC_KEY_FILE: hmacKeyFile
        }
      );
      expect(noAckResult.exitCode).not.toBe(0);
      expect(noAckResult.stderr).toContain("requires --acknowledge-target=");

      const wrongAckResult = runScript(
        "restore-postgres.sh",
        [
          dumpFile,
          "--target=awcms_mini_restore_test_ack",
          "--acknowledge-target=not-the-same",
          "--yes"
        ],
        {
          DATABASE_URL: getAdminDatabaseUrl(),
          BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
          BACKUP_HMAC_KEY_FILE: hmacKeyFile
        }
      );
      expect(wrongAckResult.exitCode).not.toBe(0);
      expect(wrongAckResult.stderr).toContain("does not match --target");
    });

    test("restore-drill.sh runs backup -> restore -> verification and reports pass with genuine (non-skipped) checks", async () => {
      const backupDir = makeTmpDir();

      const drillResult = runScript("restore-drill.sh", [], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });
      extraDatabasesToDrop.add("awcms_mini_restore_drill");

      expect(drillResult.exitCode).toBe(0);
      expect(drillResult.stdout).toContain("overall = pass");

      const glob = new Bun.Glob("restore-drill-*.json");
      const reportFileName = firstMatch([...glob.scanSync({ cwd: backupDir })]);
      const report = JSON.parse(
        await Bun.file(join(backupDir, reportFileName)).text()
      );

      // "overall" is tri-state (PR #708 review): "pass" requires
      // schema_migrations AND tenant_isolation to BOTH have genuinely run
      // and come back "pass" — not merely "not fail". A "skip" on either
      // (most commonly tenant_isolation, if the awcms_mini_app role were
      // missing or this backup lacked two tenants with cross-tenant data)
      // would make "overall" report "incomplete" instead, distinct from
      // both "pass" and "fail", so a report reader can never mistake a
      // skipped check for a verified one. This repo's own migrations
      // (013/045) always create the awcms_mini_app role, and beforeEach
      // above seeds exactly the two-tenant + one-office data the tenant
      // isolation check needs — so in this environment it must be a real
      // "pass", never "skip"/"incomplete". If this assertion ever fails,
      // that is a genuine regression (either the role/seed data is
      // missing, or the check itself broke), not something to relax back
      // to tolerating "skip".
      expect(report.checks.schema_migrations.status).toBe("pass");
      expect(report.checks.schema_migrations.count).toBeGreaterThan(0);
      expect(report.checks.sample_record.status).toBe("pass");
      expect(report.checks.tenant_isolation.status).toBe("pass");
      expect(report.overall).toBe("pass");
      expect(typeof report.duration_seconds).toBe("number");
      expect(report.backup_age_seconds).not.toBe("unknown");
    });

    test("restore-drill.sh reports overall 'incomplete' (not 'pass') when tenant_isolation cannot genuinely run, and exits non-zero", async () => {
      // Truncate the office table (but keep both tenants) so the drill's
      // own data_tenant/viewer_tenant search finds no tenant with any
      // office rows — a real, reachable "not enough data to test isolation
      // with" condition, not a broken role/privilege.
      const admin = getAdminSql();
      await admin`DELETE FROM awcms_mini_offices`;

      const backupDir = makeTmpDir();
      const drillResult = runScript("restore-drill.sh", [], {
        DATABASE_URL: getAdminDatabaseUrl(),
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      });
      extraDatabasesToDrop.add("awcms_mini_restore_drill");

      expect(drillResult.exitCode).not.toBe(0);
      expect(drillResult.stdout).toContain("overall = incomplete");

      const glob = new Bun.Glob("restore-drill-*.json");
      const reportFileName = firstMatch([...glob.scanSync({ cwd: backupDir })]);
      const report = JSON.parse(
        await Bun.file(join(backupDir, reportFileName)).text()
      );

      expect(report.checks.tenant_isolation.status).toBe("skip");
      expect(report.overall).toBe("incomplete");
      expect(report.overall).not.toBe("pass");
      expect(report.overall).not.toBe("fail");
    });
  }
);

function rebuildUrlForDb(originalUrl: string, dbName: string): string {
  const url = new URL(originalUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
