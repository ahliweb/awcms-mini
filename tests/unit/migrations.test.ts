import { describe, expect, test } from "bun:test";
import { loadMigrationFiles } from "../../src/lib/database/migrations";

describe("migration loader", () => {
  test("loads ordered sql migrations with checksums", async () => {
    const migrations = await loadMigrationFiles("sql");
    expect(migrations.map((migration) => migration.name)).toEqual([
      "001_awcms_foundation_schema.sql",
    ]);
    expect(migrations[0].checksum).toHaveLength(64);
  });
});
