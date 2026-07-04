import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumContent,
  loadMigrationFiles,
  planMigrations,
  type MigrationFile
} from "../../src/lib/database/migrations";

const SQL_DIR = join(import.meta.dirname, "..", "..", "sql");

function file(name: string, sequence: number, content: string): MigrationFile {
  return { name, sequence, content, checksum: checksumContent(content) };
}

describe("migration runner (doc 16)", () => {
  test("file sql/ repo valid: pola nama, urutan, tanpa BEGIN/COMMIT", async () => {
    const files = await loadMigrationFiles(SQL_DIR);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files[0]?.name).toBe("001_awcms_foundation_schema.sql");
    for (const migration of files) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("nama tidak valid ditolak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awcms-mig-"));
    writeFileSync(join(dir, "001_salah_prefix.sql"), "SELECT 1;");
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/tidak valid/);
  });

  test("BEGIN/COMMIT di dalam file ditolak (runner yang membungkus)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awcms-mig-"));
    writeFileSync(join(dir, "001_awcms_test_x.sql"), "BEGIN;\nSELECT 1;\nCOMMIT;");
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/BEGIN\/COMMIT/);
  });

  test("nomor duplikat ditolak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awcms-mig-"));
    writeFileSync(join(dir, "001_awcms_test_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "001_awcms_test_b.sql"), "SELECT 2;");
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/duplikat/);
  });

  test("planMigrations memisahkan pending/applied/drift", () => {
    const files = [
      file("001_awcms_test_a.sql", 1, "SELECT 1;"),
      file("002_awcms_test_b.sql", 2, "SELECT 2;"),
      file("003_awcms_test_c.sql", 3, "SELECT 3;")
    ];
    const plan = planMigrations(files, [
      { migration_name: "001_awcms_test_a.sql", checksum: files[0]!.checksum },
      { migration_name: "002_awcms_test_b.sql", checksum: "checksum-lama-berbeda" }
    ]);
    expect(plan.applied).toEqual(["001_awcms_test_a.sql"]);
    expect(plan.drifted.map((d) => d.name)).toEqual(["002_awcms_test_b.sql"]);
    expect(plan.pending.map((p) => p.name)).toEqual(["003_awcms_test_c.sql"]);
  });
});
