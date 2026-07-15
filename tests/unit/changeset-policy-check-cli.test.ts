/**
 * CLI-wiring proof for Issue #810/#811 — spawns the REAL
 * `scripts/changeset-policy-check.ts` (exactly what `bun run
 * changesets:policy:check` runs) as a genuine separate `bun` process
 * against a disposable temp git repo, and asserts on its actual exit code.
 *
 * `tests/unit/changeset-policy-check.test.ts` already thoroughly tests
 * `evaluateChangesetPolicy`/`validateChangesetFrontmatter` as pure
 * functions. This file exists because the bug class that actually shipped
 * here (PR #811) lived entirely in the IMPERATIVE git-I/O wiring around
 * those pure functions — `getDeletedFiles`, `isPackageJsonVersionOnlyChange`,
 * and how their results get threaded into `evaluateChangesetPolicy` — none
 * of which a pure-function unit test can exercise. A correctly-implemented,
 * correctly-unit-tested pure decision function can still be wired up wrong
 * (this repo's own precedent: PR #769/#770's "validator exists but
 * unwired" pattern) — spawning the actual CLI against a real git history is
 * the only way to prove the wiring itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "changeset-policy-check.ts");

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function gitRevParse(cwd: string, ref: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", ref], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited
  ]);
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "awcms-mini-changeset-policy-test-"));
  tmpDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function runCli(cwd: string, baseSha: string): Promise<CliResult> {
  const proc = Bun.spawn(["bun", SCRIPT_PATH], {
    cwd,
    env: { ...process.env, CHANGESET_POLICY_BASE_REF: baseSha },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { exitCode, stdout, stderr };
}

describe("changesets:policy:check CLI — release-consumption commit (Issue #810)", () => {
  test("a real bun run changeset:version-shaped commit (package.json version-only bump + deleted changesets) passes without a new changeset", async () => {
    const dir = await initRepo();

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "awcms-mini", version: "0.1.0" }, null, 2)
    );
    Bun.spawnSync(["mkdir", "-p", join(dir, ".changeset")]);
    writeFileSync(
      join(dir, ".changeset", "foo.md"),
      '---\n"awcms-mini": patch\n---\n\nFix a bug.\n'
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "initial"]);
    const baseSha = await gitRevParse(dir, "HEAD");

    // The release-consumption step: bump ONLY the version field, delete
    // the consumed changeset, update CHANGELOG.md.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "awcms-mini", version: "0.2.0" }, null, 2)
    );
    rmSync(join(dir, ".changeset", "foo.md"));
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## 0.2.0\n\nFix a bug.\n"
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "chore(release): v0.2.0"]);

    const result = await runCli(dir, baseSha);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("release-consumption");
  });
});

describe("changesets:policy:check CLI — SECURITY regression (Issue #810 follow-up, security-auditor Critical on PR #811)", () => {
  test("deleting an existing pending changeset instead of adding one does NOT bypass the policy for an unrelated source change", async () => {
    const dir = await initRepo();

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "awcms-mini", version: "0.1.0" }, null, 2)
    );
    Bun.spawnSync(["mkdir", "-p", join(dir, ".changeset"), join(dir, "src")]);
    writeFileSync(
      join(dir, ".changeset", "existing-real.md"),
      '---\n"awcms-mini": minor\n---\n\nUnrelated pending feature.\n'
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "initial"]);
    const baseSha = await gitRevParse(dir, "HEAD");

    // A real behavior change (src/a.ts) that DELETES a pending changeset
    // instead of adding a new one -- must still be rejected. package.json
    // is untouched, so the release-consumption carve-out cannot apply.
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    rmSync(join(dir, ".changeset", "existing-real.md"));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "feat: add a"]);

    const result = await runCli(dir, baseSha);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tidak menambah changeset baru");
  });

  test("deleting a pending changeset AND bumping package.json's version (but touching scripts/dependencies too) still requires a changeset", async () => {
    const dir = await initRepo();

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "awcms-mini", version: "0.1.0", scripts: { build: "old" } },
        null,
        2
      )
    );
    Bun.spawnSync(["mkdir", "-p", join(dir, ".changeset")]);
    writeFileSync(
      join(dir, ".changeset", "existing-real.md"),
      '---\n"awcms-mini": minor\n---\n\nUnrelated pending feature.\n'
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "initial"]);
    const baseSha = await gitRevParse(dir, "HEAD");

    // package.json's version DID change, but so did `scripts` -- this is
    // NOT a version-only change, so it must not qualify for the
    // release-consumption carve-out even though a changeset was deleted.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "awcms-mini", version: "0.2.0", scripts: { build: "new" } },
        null,
        2
      )
    );
    rmSync(join(dir, ".changeset", "existing-real.md"));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "sneaky change"]);

    const result = await runCli(dir, baseSha);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tidak menambah changeset baru");
  });
});
