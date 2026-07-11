/**
 * Unit tests for Issue #691 (epic #679) — deploy/backup/{backup,restore}-
 * postgres.sh, offsite-copy.sh hardening: encrypted backups, signed
 * manifests, credential-safe invocation, and tamper/incomplete-backup
 * rejection BEFORE any restore mutation.
 *
 * These tests spawn the real shell scripts via Bun.spawnSync and assert on
 * exit code / stdout / stderr — no real PostgreSQL is required, because
 * every behavior asserted here (missing key files, missing/mismatched
 * manifest, tampered manifest HMAC, tampered dump checksum, missing dump
 * file, bad CLI usage) is rejected by these scripts BEFORE they ever
 * attempt a database connection (see backup-postgres.sh's/
 * restore-postgres.sh's own ordering: secret-file checks first, then —
 * for restore — manifest HMAC, then dump-file sha256, then decrypt +
 * `pg_restore --list`, and only THEN DATABASE_URL parsing/connection).
 *
 * Manifest HMAC fixtures are built here with Node's `crypto.createHmac`,
 * matching exactly the `HMAC(secret, "<timestamp>.<body>")` construction
 * backup-common.sh's `hmac_sha256_string` implements via
 * `openssl dgst -sha256 -hmac`, as long as the key file has no trailing
 * newline (bash's `$(cat key_file)` strips trailing newlines; write the
 * fixture key without one so both sides read identical bytes).
 *
 * Tests that need a real, structurally valid encrypted pg_dump archive
 * (e.g. "restore-postgres.sh rejects --target equal to the source db",
 * which is only reached after manifest/checksum/pg_restore --list all
 * pass) live in
 * tests/integration/backup-restore-drill.integration.test.ts instead,
 * gated on DATABASE_URL like the rest of this repo's integration suite.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BACKUP_SCRIPTS_DIR = join(REPO_ROOT, "deploy", "backup");

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "awcms-mini-backup-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function writeKeyFile(dir: string, name: string, keyValue?: string): string {
  const path = join(dir, name);
  // No trailing newline, so bash's `$(cat key_file)` (which strips trailing
  // newlines from command substitution) reads back byte-identical content.
  writeFileSync(path, keyValue ?? randomBytes(32).toString("base64"));
  return path;
}

type RunResult = { exitCode: number; stdout: string; stderr: string };

function runScript(
  scriptName: string,
  args: string[],
  env: Record<string, string>
): RunResult {
  const proc = Bun.spawnSync([join(BACKUP_SCRIPTS_DIR, scriptName), ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString()
  };
}

// A DATABASE_URL that is syntactically valid but never actually reachable —
// safe to use in every test in this file because none of them reach the
// point where these scripts attempt a real connection.
const UNREACHABLE_DATABASE_URL = "postgres://fake:fake@127.0.0.1:1/fake";

describe("backup-postgres.sh — refuses to run without key files (Issue #691 scope item 1/2)", () => {
  test("refuses clearly when BACKUP_ENCRYPTION_KEY_FILE is not set", () => {
    const dir = makeTmpDir();
    const result = runScript("backup-postgres.sh", [], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_DIR: dir
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BACKUP_ENCRYPTION_KEY_FILE is not set");
  });

  test("refuses clearly when BACKUP_HMAC_KEY_FILE is not set", () => {
    const dir = makeTmpDir();
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const result = runScript("backup-postgres.sh", [], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_DIR: dir,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BACKUP_HMAC_KEY_FILE is not set");
  });

  test("refuses clearly when the key file exists but is empty", () => {
    const dir = makeTmpDir();
    const encKeyFile = join(dir, "empty.key");
    writeFileSync(encKeyFile, "");
    const result = runScript("backup-postgres.sh", [], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_DIR: dir,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("is empty");
  });

  test("refuses clearly when DATABASE_URL is not set at all", () => {
    const dir = makeTmpDir();
    const result = runScript("backup-postgres.sh", [], { BACKUP_DIR: dir });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });
});

describe("restore-postgres.sh — CLI usage and missing-file guards (no DB needed)", () => {
  test("prints usage and refuses when no dump file argument is given", () => {
    const result = runScript("restore-postgres.sh", [], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });

  test("refuses clearly when the dump file does not exist", () => {
    const dir = makeTmpDir();
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const hmacKeyFile = writeKeyFile(dir, "hmac.key");
    const result = runScript(
      "restore-postgres.sh",
      [join(dir, "does-not-exist.dump.enc")],
      {
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
        BACKUP_HMAC_KEY_FILE: hmacKeyFile
      }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dump file not found");
  });

  test("refuses clearly when the manifest file is missing", () => {
    const dir = makeTmpDir();
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const hmacKeyFile = writeKeyFile(dir, "hmac.key");
    const dumpFile = join(dir, "awcms_mini_20260101_000000.dump.enc");
    writeFileSync(dumpFile, "not a real dump, no manifest alongside it");

    const result = runScript("restore-postgres.sh", [dumpFile], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
      BACKUP_HMAC_KEY_FILE: hmacKeyFile
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest not found");
  });
});

describe("restore-postgres.sh — manifest HMAC / checksum verification rejects tampering BEFORE any restore mutation (Issue #691 scope item 3)", () => {
  function buildSignedFixture(
    dir: string,
    hmacKeyValue: string,
    options?: { corruptManifestHmac?: boolean }
  ): { dumpFile: string; manifestFile: string } {
    const dumpBytes = Buffer.from(
      "not a real pg_dump archive — just fixture bytes for checksum/HMAC tests"
    );
    const fileName = "awcms_mini_20260101_000000.dump.enc";
    const dumpFile = join(dir, fileName);
    writeFileSync(dumpFile, dumpBytes);

    const size = dumpBytes.length;
    const sha256 = createHash("sha256").update(dumpBytes).digest("hex");
    const createdAt = "2026-01-01T00:00:00Z";
    const signatureInput = `${createdAt}.${fileName}.${size}.${sha256}`;
    let hmac = createHmac("sha256", hmacKeyValue)
      .update(signatureInput)
      .digest("hex");
    if (options?.corruptManifestHmac) {
      hmac = hmac.split("").reverse().join("");
    }

    const manifestFile = join(dir, "awcms_mini_20260101_000000.manifest.json");
    writeFileSync(
      manifestFile,
      JSON.stringify(
        {
          file: fileName,
          size,
          sha256,
          created_at: createdAt,
          hmac_sha256: hmac
        },
        null,
        2
      )
    );

    return { dumpFile, manifestFile };
  }

  test("rejects a manifest whose HMAC does not match the HMAC key — before decrypting or touching any database", () => {
    const dir = makeTmpDir();
    const hmacKeyValue = randomBytes(32).toString("base64");
    const hmacKeyFile = writeKeyFile(dir, "hmac.key", hmacKeyValue);
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const { dumpFile } = buildSignedFixture(dir, hmacKeyValue, {
      corruptManifestHmac: true
    });

    const result = runScript("restore-postgres.sh", [dumpFile], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
      BACKUP_HMAC_KEY_FILE: hmacKeyFile
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest HMAC verification FAILED");
    // Proves rejection happened before any later stage ran.
    expect(result.stdout).not.toContain("decrypting");
    expect(result.stdout).not.toContain("restoring into");
  });

  test("rejects when BACKUP_HMAC_KEY_FILE does not match the key the manifest was signed with", () => {
    const dir = makeTmpDir();
    const signingKeyValue = randomBytes(32).toString("base64");
    const wrongKeyFile = writeKeyFile(
      dir,
      "wrong-hmac.key",
      randomBytes(32).toString("base64")
    );
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const { dumpFile } = buildSignedFixture(dir, signingKeyValue);

    const result = runScript("restore-postgres.sh", [dumpFile], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
      BACKUP_HMAC_KEY_FILE: wrongKeyFile
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest HMAC verification FAILED");
  });

  test("accepts a correctly signed manifest far enough to reach the dump-integrity check", () => {
    const dir = makeTmpDir();
    const hmacKeyValue = randomBytes(32).toString("base64");
    const hmacKeyFile = writeKeyFile(dir, "hmac.key", hmacKeyValue);
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const { dumpFile } = buildSignedFixture(dir, hmacKeyValue);

    const result = runScript("restore-postgres.sh", [dumpFile], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
      BACKUP_HMAC_KEY_FILE: hmacKeyFile
    });

    // Manifest HMAC verifies OK; the fixture bytes are not real ciphertext,
    // so it fails later (decrypt/pg_restore --list) — proving the manifest
    // check itself passed rather than rejecting everything indiscriminately.
    expect(result.stdout).toContain("manifest HMAC verified OK");
    expect(result.stdout).toContain(
      "dump file integrity verified against manifest OK"
    );
    expect(result.exitCode).not.toBe(0);
  });

  test("rejects an incomplete/truncated dump file (bytes changed after the manifest was signed) — sha256 mismatch, before decrypting", () => {
    const dir = makeTmpDir();
    const hmacKeyValue = randomBytes(32).toString("base64");
    const hmacKeyFile = writeKeyFile(dir, "hmac.key", hmacKeyValue);
    const encKeyFile = writeKeyFile(dir, "enc.key");
    const { dumpFile } = buildSignedFixture(dir, hmacKeyValue);

    // Simulate corruption that preserves length but flips content (so this
    // exercises the sha256 check specifically, not the earlier size check):
    // manifest is untouched (so its own HMAC still verifies), but the bytes
    // on disk no longer match the sha256 the manifest recorded.
    const originalSize = Bun.file(dumpFile).size;
    writeFileSync(dumpFile, Buffer.alloc(originalSize, "Z"));

    const result = runScript("restore-postgres.sh", [dumpFile], {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      BACKUP_ENCRYPTION_KEY_FILE: encKeyFile,
      BACKUP_HMAC_KEY_FILE: hmacKeyFile
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("manifest HMAC verified OK");
    expect(result.stderr).toContain("sha256 mismatch");
    expect(result.stdout).not.toContain("decrypting");
  });
});

describe("offsite-copy.sh — generic off-site hook (Issue #691 scope item 7)", () => {
  test("is a documented no-op when OFFSITE_COPY_COMMAND is not set (offline/LAN deployments)", () => {
    const dir = makeTmpDir();
    const file = join(dir, "some.dump.enc");
    writeFileSync(file, "x");

    const result = runScript("offsite-copy.sh", [file], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("is optional and is being skipped");
  });

  test("invokes OFFSITE_COPY_COMMAND with the file path appended", () => {
    const dir = makeTmpDir();
    const destDir = join(dir, "dest");
    Bun.spawnSync(["mkdir", "-p", destDir]);
    const file = join(dir, "some.dump.enc");
    writeFileSync(file, "hello off-site");

    const result = runScript("offsite-copy.sh", [file], {
      OFFSITE_COPY_COMMAND: `cp -t ${destDir}`
    });

    expect(result.exitCode).toBe(0);
    const copied = Bun.spawnSync(["cat", join(destDir, "some.dump.enc")]);
    expect(copied.stdout.toString()).toBe("hello off-site");
  });

  test("fails clearly when a given file does not exist", () => {
    const dir = makeTmpDir();
    const result = runScript(
      "offsite-copy.sh",
      [join(dir, "missing.dump.enc")],
      { OFFSITE_COPY_COMMAND: "true" }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("file not found");
  });
});
