/**
 * Integration tests for `scripts/dr-drill.ts` (Issue #699, epic #679
 * platform-hardening) against a REAL PostgreSQL: the safety interlock
 * genuinely blocking execution (proven by spawning the real CLI as a
 * separate process, not just unit-testing the pure gate function), and a
 * full safe-subset run producing a "pass" JSON report with every expected
 * scenario present.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminDatabaseUrl,
  integrationEnabled
} from "./harness";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DR_DRILL_SCRIPT = join(REPO_ROOT, "scripts", "dr-drill.ts");

const suite = integrationEnabled ? describe : describe.skip;

function runDrDrill(
  args: string[],
  env: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", DR_DRILL_SCRIPT, ...args], {
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

suite("dr-drill.ts (Issue #699) — real Postgres", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await applyMigrations();
    tmpDir = mkdtempSync(join(tmpdir(), "awcms-mini-dr-drill-it-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("refuses to run when APP_ENV=production, regardless of a matching --confirm-non-production", () => {
    const result = runDrDrill(["--confirm-non-production=production"], {
      PATH: process.env.PATH ?? "",
      APP_ENV: "production",
      DATABASE_URL: getAdminDatabaseUrl()
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stderr).toContain("production");
    // No scenario summary should ever be printed — the block happens
    // before anything runs.
    expect(result.stdout).not.toContain("dr-drill — summary");
  });

  test("refuses to run against a production-like database host even when APP_ENV is not production", () => {
    const result = runDrDrill(["--confirm-non-production=test"], {
      PATH: process.env.PATH ?? "",
      APP_ENV: "test",
      DATABASE_URL: "postgres://user:pass@prod-db.internal:5432/db"
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stdout).not.toContain("dr-drill — summary");
  });

  test("refuses to run without --confirm-non-production even against a safe target", () => {
    const result = runDrDrill([], {
      PATH: process.env.PATH ?? "",
      APP_ENV: "test",
      DATABASE_URL: getAdminDatabaseUrl()
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stderr).toContain("--confirm-non-production");
  });

  test("runs the safe-subset scenarios against a real, authorized isolated database and reports overall pass", () => {
    const jsonOutputPath = join(tmpDir, "dr-drill-report.json");

    const result = runDrDrill(
      ["--confirm-non-production=test", `--json-output=${jsonOutputPath}`],
      {
        PATH: process.env.PATH ?? "",
        APP_ENV: "test",
        DATABASE_URL: getAdminDatabaseUrl()
      }
    );

    if (result.exitCode !== 0) {
      // Surface full output on failure to aid debugging without needing
      // a separate manual repro run.
      console.error(result.stdout, result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("overall = pass");

    const report = JSON.parse(readFileSync(jsonOutputPath, "utf8")) as {
      overall: string;
      tier: string;
      scenarios: { name: string; status: string; metrics: unknown }[];
    };

    expect(report.overall).toBe("pass");
    expect(report.tier).toBe("safe");

    const scenarioNames = report.scenarios.map((s) => s.name).sort();
    expect(scenarioNames).toEqual(
      [
        "provider-outage-email",
        "provider-outage-sso-discovery",
        "pool-saturation",
        "postgres-disconnect",
        "worker-interruption"
      ].sort()
    );

    for (const scenario of report.scenarios) {
      expect(scenario.status).toBe("pass");
    }

    const postgresDisconnect = report.scenarios.find(
      (s) => s.name === "postgres-disconnect"
    );
    expect(
      (postgresDisconnect?.metrics as Record<string, number>).reconnectRtoMs
    ).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
