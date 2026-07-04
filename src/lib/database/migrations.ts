import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type MigrationFile = {
  name: string;
  path: string;
  checksum: string;
  sql: string;
};

export async function loadMigrationFiles(
  sqlDir = "sql",
): Promise<MigrationFile[]> {
  const entries = await readdir(sqlDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^\d{3}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    files.map(async (name) => {
      const path = join(sqlDir, name);
      const sql = await readFile(path, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      return { name, path, checksum, sql };
    }),
  );
}
