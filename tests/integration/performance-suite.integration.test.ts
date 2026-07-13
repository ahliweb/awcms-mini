/**
 * Integration tests for `scripts/performance-suite.ts` (Issue #744, epic
 * #738) against a REAL PostgreSQL: the safety interlock genuinely
 * blocking execution (proven by spawning the real CLI as a separate
 * process, mirroring `tests/integration/dr-drill.integration.test.ts`'s
 * own pattern), and a full safe-tier run producing a "pass" JSON report
 * with every expected scenario present and DSN credentials redacted.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  integrationEnabled,
  provisionAppRole
} from "./harness";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PERFORMANCE_SUITE_SCRIPT = join(
  REPO_ROOT,
  "scripts",
  "performance-suite.ts"
);

const suite = integrationEnabled ? describe : describe.skip;

const EXPECTED_SAFE_TIER_SCENARIOS = [
  "background-sync-claim-load",
  "critical-transaction-integrity",
  "interactive-load",
  "reporting-under-load",
  "saturation-and-recovery"
].sort();

function runPerformanceSuite(
  args: string[],
  env: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", PERFORMANCE_SUITE_SCRIPT, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString()
  };
}

suite("performance-suite.ts (Issue #744) — real Postgres", () => {
  let appRoleDatabaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    // provisionAppRole() repoints process.env.DATABASE_URL to the
    // least-privilege awcms_mini_app role in THIS process — capture it so
    // the spawned subprocess below connects as the SAME role (never the
    // migration-owner/superuser role), consistent with fixture-seeder.ts's
    // own "never a privileged RLS bypass" design.
    appRoleDatabaseUrl = process.env.DATABASE_URL ?? "";
    tmpDir = mkdtempSync(join(tmpdir(), "awcms-mini-performance-suite-it-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("refuses to run when APP_ENV=production, regardless of a matching --confirm-non-production", () => {
    const result = runPerformanceSuite(
      ["--confirm-non-production=production"],
      {
        PATH: process.env.PATH ?? "",
        APP_ENV: "production",
        DATABASE_URL: appRoleDatabaseUrl
      }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stdout).not.toContain("performance-suite — summary");
  });

  test("refuses to run against a production-like database host even when APP_ENV is not production", () => {
    const result = runPerformanceSuite(["--confirm-non-production=test"], {
      PATH: process.env.PATH ?? "",
      APP_ENV: "test",
      DATABASE_URL: "postgres://user:pass@prod-db.internal:5432/db"
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
  });

  test("refuses to run without --confirm-non-production even against a safe target", () => {
    const result = runPerformanceSuite([], {
      PATH: process.env.PATH ?? "",
      APP_ENV: "test",
      DATABASE_URL: appRoleDatabaseUrl
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
  });

  test("runs the safe tier end to end: seeds fixtures, runs every expected scenario, and produces a redacted, passing JSON + human report", () => {
    const jsonPath = join(tmpDir, "report.json");
    const reportPath = join(tmpDir, "report.md");
    const seed = `performance-suite-it-${Date.now()}`;

    const result = runPerformanceSuite(
      [
        "--confirm-non-production=test",
        `--seed=${seed}`,
        `--json-output=${jsonPath}`,
        `--report-path=${reportPath}`
      ],
      {
        PATH: process.env.PATH ?? "",
        APP_ENV: "test",
        DATABASE_URL: appRoleDatabaseUrl
      }
    );

    expect(result.exitCode).toBe(0);

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      overall: string;
      tier: string;
      environment: { databaseUrlRedacted: string };
      scenarios: { name: string; status: string }[];
    };

    expect(report.overall).toBe("pass");
    expect(report.tier).toBe("safe");
    expect(report.scenarios.map((scenario) => scenario.name).sort()).toEqual(
      EXPECTED_SAFE_TIER_SCENARIOS
    );
    expect(
      report.scenarios.every((scenario) => scenario.status === "pass")
    ).toBe(true);

    // Redaction: the report must never contain the raw app-role
    // credentials from the DATABASE_URL it ran against.
    const rawJson = readFileSync(jsonPath, "utf8");
    expect(rawJson).not.toContain("awcms_mini_app");
    expect(report.environment.databaseUrlRedacted).toContain("<redacted>");

    const humanReport = readFileSync(reportPath, "utf8");
    expect(humanReport).toContain("# AWCMS-Mini performance suite report");
    expect(humanReport).toContain("PASS");
  }, 60_000);
});
