/**
 * Unit tests for the local/offline archive adapter (Issue #745) — pure
 * filesystem, no database. Covers write/checksum determinism, verify()
 * catching tampering, and read() round-tripping both JSONL and CSV
 * (including values that need CSV escaping), plus the restore procedure
 * reference always being populated — the acceptance criterion "Archive
 * artifacts have deterministic manifests and verified checksums;
 * reconciliation/restore is documented and tested" is exercised here at
 * the adapter level.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createLocalArchiveAdapter,
  LOCAL_ARCHIVE_RESTORE_PROCEDURE_REF
} from "../../src/modules/data-lifecycle/infrastructure/local-archive-adapter";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "awcms-data-lifecycle-archive-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE_ROWS = [
  { id: "1", message: "hello", count: 3, note: null },
  {
    id: "2",
    message: 'has a "quote", and, commas',
    count: 7,
    note: "line1\nline2"
  }
];

describe("createLocalArchiveAdapter — write/verify/read (JSONL)", () => {
  test("write() produces a file whose checksum verify() confirms, and read() round-trips the exact rows", async () => {
    const adapter = createLocalArchiveAdapter(dir);

    const result = await adapter.write({
      descriptorKey: "data_lifecycle.data_lifecycle_runs",
      tenantId: "11111111-1111-1111-1111-111111111111",
      format: "jsonl",
      schemaVersion: "1",
      rows: SAMPLE_ROWS,
      cursorRangeStart: new Date("2026-01-01T00:00:00.000Z"),
      cursorRangeEnd: new Date("2026-01-02T00:00:00.000Z")
    });

    expect(result.rowCount).toBe(2);
    expect(result.checksumHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.restoreProcedureRef).toBe(
      LOCAL_ARCHIVE_RESTORE_PROCEDURE_REF
    );
    expect(result.artifactLocation).toContain(dir);
    expect(result.artifactLocation).toContain("data_lifecycle");
    expect(result.artifactLocation).toContain("data_lifecycle_runs");

    const verified = await adapter.verify(
      result.artifactLocation,
      result.checksumHex
    );
    expect(verified).toBe(true);

    const readBack = await adapter.read(result.artifactLocation);
    expect(readBack).toEqual(SAMPLE_ROWS);
  });

  test("verify() returns false for a WRONG checksum (tamper detection)", async () => {
    const adapter = createLocalArchiveAdapter(dir);
    const result = await adapter.write({
      descriptorKey: "data_lifecycle.data_lifecycle_runs",
      tenantId: "11111111-1111-1111-1111-111111111111",
      format: "jsonl",
      schemaVersion: "1",
      rows: SAMPLE_ROWS,
      cursorRangeStart: null,
      cursorRangeEnd: null
    });

    const verified = await adapter.verify(
      result.artifactLocation,
      "0".repeat(64) // definitely wrong
    );
    expect(verified).toBe(false);
  });

  test("verify() returns false (not throws) for a missing artifact", async () => {
    const adapter = createLocalArchiveAdapter(dir);
    const verified = await adapter.verify(
      `${dir}/nonexistent/file.jsonl`,
      "0".repeat(64)
    );
    expect(verified).toBe(false);
  });

  test("read() throws a clear error for a missing artifact (never silently returns empty)", async () => {
    const adapter = createLocalArchiveAdapter(dir);
    await expect(
      adapter.read(`${dir}/nonexistent/file.jsonl`)
    ).rejects.toBeInstanceOf(Error);
  });

  test("write() with zero rows still produces a verifiable (empty) artifact", async () => {
    const adapter = createLocalArchiveAdapter(dir);
    const result = await adapter.write({
      descriptorKey: "data_lifecycle.data_lifecycle_runs",
      tenantId: "11111111-1111-1111-1111-111111111111",
      format: "jsonl",
      schemaVersion: "1",
      rows: [],
      cursorRangeStart: null,
      cursorRangeEnd: null
    });

    expect(result.rowCount).toBe(0);
    const verified = await adapter.verify(
      result.artifactLocation,
      result.checksumHex
    );
    expect(verified).toBe(true);
    const readBack = await adapter.read(result.artifactLocation);
    expect(readBack).toEqual([]);
  });

  test("two writes for the same descriptor/tenant/range never collide (unique filenames)", async () => {
    const adapter = createLocalArchiveAdapter(dir);
    const input = {
      descriptorKey: "data_lifecycle.data_lifecycle_runs",
      tenantId: "11111111-1111-1111-1111-111111111111",
      format: "jsonl" as const,
      schemaVersion: "1",
      rows: SAMPLE_ROWS,
      cursorRangeStart: null,
      cursorRangeEnd: null
    };

    const first = await adapter.write(input);
    const second = await adapter.write(input);

    expect(first.artifactLocation).not.toBe(second.artifactLocation);
  });
});

describe("createLocalArchiveAdapter — write/verify/read (CSV)", () => {
  test("CSV round-trips rows containing commas, quotes, and newlines correctly", async () => {
    const adapter = createLocalArchiveAdapter(dir);

    const result = await adapter.write({
      descriptorKey: "data_lifecycle.data_lifecycle_runs",
      tenantId: "11111111-1111-1111-1111-111111111111",
      format: "csv",
      schemaVersion: "1",
      rows: SAMPLE_ROWS,
      cursorRangeStart: null,
      cursorRangeEnd: null
    });

    const verified = await adapter.verify(
      result.artifactLocation,
      result.checksumHex
    );
    expect(verified).toBe(true);

    const readBack = await adapter.read(result.artifactLocation);
    expect(readBack).toHaveLength(2);
    // CSV round-trips every value as a string (no per-column type schema —
    // see this adapter's own header comment) or null for empty fields.
    expect(readBack[0]).toEqual({
      id: "1",
      message: "hello",
      count: "3",
      note: null
    });
    expect(readBack[1]).toEqual({
      id: "2",
      message: 'has a "quote", and, commas',
      count: "7",
      note: "line1\nline2"
    });
  });
});
