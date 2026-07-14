/**
 * Adversarial pipeline proof for Issue #741 — spawns the REAL CLI
 * (`bun run scripts/extension-check.ts`, i.e. exactly what `bun run
 * extension:check` runs) as a genuine separate `bun` process against
 * every fixture, and asserts on its actual exit code + printed output.
 *
 * This is deliberately NOT just calling `evaluateExtensionManifest`/
 * `evaluateExtensionCompatibility` directly (that is
 * `tests/unit/extension-compatibility.test.ts`'s job, already thorough
 * per issue class) — the class of bug this repo's own recent history
 * warns about (PR #769/#770, see this issue's own PR description) is a
 * correctly-implemented, correctly-unit-tested validator FUNCTION that
 * the real CLI/consumer never actually calls on the path that matters.
 * Spawning the actual script file is the only way to prove the wiring
 * itself — argument parsing, manifest file resolution, YAML/JSON
 * loading, real migration-file checksum discovery, real `package.json`/
 * OpenAPI/AsyncAPI reads, and the final `process.exitCode` — all work
 * end to end, not just that the underlying function returns the right
 * boolean when called directly.
 *
 * No database, no network — every fixture is a static file under
 * `tests/fixtures/`, and the script itself performs only local
 * filesystem reads.
 */
import { describe, expect, test } from "bun:test";

const FIXTURES_DIR = "tests/fixtures/derived-application-example";
const INCOMPATIBLE_DIR = "tests/fixtures/extension-contract-incompatible";

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(
    ["bun", "run", "scripts/extension-check.ts", ...args],
    {
      stdout: "pipe",
      stderr: "pipe"
    }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  return { exitCode, stdout, stderr };
}

describe("extension:check CLI — compatible fixture (Issue #741)", () => {
  test("exits 0 and reports both manifest and module composition as valid", async () => {
    const result = await runCli([
      `--manifest=${FIXTURES_DIR}/extension.manifest.json`,
      `--migrations-dir=${FIXTURES_DIR}/sql`
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("extension:check OK");
  });

  test("--report=<path> writes a deterministic JSON report marking the run valid", async () => {
    const reportPath = `/tmp/extension-check-report-compatible-${crypto.randomUUID()}.json`;
    const result = await runCli([
      `--manifest=${FIXTURES_DIR}/extension.manifest.json`,
      `--migrations-dir=${FIXTURES_DIR}/sql`,
      `--report=${reportPath}`
    ]);

    expect(result.exitCode).toBe(0);

    const report = await Bun.file(reportPath).json();
    expect(report.valid).toBe(true);
    expect(report.manifestChecked).toBe(true);
    expect(report.manifestIssues).toEqual([]);
    expect(report.moduleCompositionIssues).toEqual([]);

    await Bun.file(reportPath).delete();
  });
});

describe("extension:check CLI — no manifest present (base-repo-safe default, Issue #741)", () => {
  test("running with no --manifest flag against the real repo root passes trivially (no committed root-level manifest)", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("extension:check OK");
    expect(result.stdout + result.stderr).toContain(
      "no compatibility manifest found"
    );
  });
});

describe("extension:check CLI — explicit missing manifest path is a hard failure (Issue #741)", () => {
  test("a --manifest= path that does not exist fails loudly, distinct from 'no manifest found'", async () => {
    const result = await runCli([
      "--manifest=tests/fixtures/derived-application-example/does-not-exist.json"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("not found");
  });
});

/**
 * The core adversarial proof: every one of these eight fixtures is a
 * clone of the compatible manifest with exactly ONE deliberate defect
 * (see `tests/fixtures/extension-contract-incompatible/README.md` for
 * the full table) — each must be REJECTED by the real spawned CLI for
 * its own specific, distinct reason. Satisfies the acceptance criterion
 * "At least five incompatible fixtures prove the gates fail for distinct
 * reasons" with eight, and proves it through the full pipeline (process
 * spawn + exit code + printed diagnostic), not a direct function call.
 */
describe.each([
  [
    "base-version-range",
    "does not satisfy the manifest's declared compatible range"
  ],
  [
    "module-contract-version",
    "unsupported by this release's actual module contract version"
  ],
  ["unknown-capability", "neither a known base capability nor declared"],
  [
    "capability-version-mismatch",
    "unsupported by the base repository's actual version"
  ],
  [
    "duplicate-migration",
    "is declared 2 times in migrations.historicalChecksums"
  ],
  ["migration-checksum-changed", "checksum changed"],
  ["stale-api-contract", "is stale relative to the actual"],
  ["deployment-profile-unsupported", "does not declare support for it"]
])(
  "extension:check CLI — incompatible fixture: %s (Issue #741)",
  (caseName, expectedMessageFragment) => {
    test(`rejects with exit code 1 and mentions "${expectedMessageFragment}"`, async () => {
      const result = await runCli([
        `--manifest=${INCOMPATIBLE_DIR}/${caseName}/extension.manifest.json`,
        `--migrations-dir=${FIXTURES_DIR}/sql`
      ]);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("extension:check FAILED");
      expect(output).toContain(expectedMessageFragment);
    });
  }
);

describe("extension:check CLI — every incompatible fixture fails for a genuinely DIFFERENT primary issue type (Issue #741)", () => {
  test("the eight fixtures produce eight distinct issue-type sets via --report=, not the same check five times", async () => {
    // Spawns 8 sequential extension:check CLI subprocesses against the full
    // module registry — already ~4.4s on main and growing with every module
    // this epic adds, so bun's 5000ms default per-test timeout is too tight.
    const caseNames = [
      "base-version-range",
      "module-contract-version",
      "unknown-capability",
      "capability-version-mismatch",
      "duplicate-migration",
      "migration-checksum-changed",
      "stale-api-contract",
      "deployment-profile-unsupported"
    ];

    const primaryIssueTypesPerCase: string[][] = [];

    for (const caseName of caseNames) {
      const reportPath = `/tmp/extension-check-report-${caseName}-${crypto.randomUUID()}.json`;
      const result = await runCli([
        `--manifest=${INCOMPATIBLE_DIR}/${caseName}/extension.manifest.json`,
        `--migrations-dir=${FIXTURES_DIR}/sql`,
        `--report=${reportPath}`
      ]);
      expect(result.exitCode).toBe(1);

      const report = await Bun.file(reportPath).json();
      expect(report.valid).toBe(false);

      const types: string[] = (report.manifestIssues as { type: string }[]).map(
        (i) => i.type
      );
      primaryIssueTypesPerCase.push([...new Set(types)].sort());

      await Bun.file(reportPath).delete();
    }

    // Every case's own issue-type SET must be unique across all eight —
    // this is the machine-checked version of "distinct reasons, not the
    // same check five times".
    const serialized = primaryIssueTypesPerCase.map((types) => types.join(","));
    expect(new Set(serialized).size).toBe(caseNames.length);
  }, 20000);
});
