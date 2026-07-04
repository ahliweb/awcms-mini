/**
 * SQL migration runner (doc 16): berurutan, checksum, transaction per file,
 * tidak double-run, error menghentikan proses.
 *
 * Konvensi file: sql/NNN_awcms_<area>_<deskripsi>.sql (doc 09/10).
 * File TIDAK boleh berisi BEGIN/COMMIT — runner yang membungkus transaction.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";

export type MigrationFile = {
  name: string;
  sequence: number;
  content: string;
  checksum: string;
};

export type AppliedMigration = {
  migration_name: string;
  checksum: string | null;
};

export type MigrationPlan = {
  pending: MigrationFile[];
  applied: string[];
  drifted: Array<{ name: string; expected: string; actual: string | null }>;
};

const MIGRATION_NAME_PATTERN = /^(\d{3})_awcms_[a-z0-9_]+\.sql$/;

export function checksumContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Baca dan validasi file migration: pola nama, urutan, nomor unik. */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const name of entries) {
    const match = MIGRATION_NAME_PATTERN.exec(name);
    if (!match) {
      throw new Error(
        `Nama migration tidak valid: ${name} (harus NNN_awcms_<area>_<deskripsi>.sql)`
      );
    }
    const sequence = Number.parseInt(match[1] ?? "0", 10);
    if (seen.has(sequence)) {
      throw new Error(`Nomor migration duplikat: ${String(sequence).padStart(3, "0")}`);
    }
    seen.add(sequence);
    const content = await readFile(join(dir, name), "utf8");
    if (/^\s*(BEGIN|COMMIT)\s*;/im.test(content)) {
      throw new Error(
        `Migration ${name} berisi BEGIN/COMMIT — runner sudah membungkus transaction`
      );
    }
    files.push({ name, sequence, content, checksum: checksumContent(content) });
  }
  return files;
}

/** Bandingkan file vs ledger: mana yang pending, applied, atau drift checksum. */
export function planMigrations(
  files: MigrationFile[],
  appliedRows: AppliedMigration[]
): MigrationPlan {
  const appliedByName = new Map(appliedRows.map((row) => [row.migration_name, row.checksum]));
  const plan: MigrationPlan = { pending: [], applied: [], drifted: [] };
  for (const file of files) {
    if (!appliedByName.has(file.name)) {
      plan.pending.push(file);
      continue;
    }
    const recorded = appliedByName.get(file.name) ?? null;
    if (recorded !== null && recorded !== file.checksum) {
      plan.drifted.push({ name: file.name, expected: file.checksum, actual: recorded });
    } else {
      plan.applied.push(file.name);
    }
  }
  return plan;
}

const LEDGER_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS awcms_schema_migrations (
  id bigserial PRIMARY KEY,
  migration_name text NOT NULL UNIQUE,
  checksum text,
  executed_at timestamptz NOT NULL DEFAULT now()
);
`;

export async function readLedger(sql: Sql): Promise<AppliedMigration[]> {
  await sql.unsafe(LEDGER_BOOTSTRAP);
  return sql<AppliedMigration[]>`
    SELECT migration_name, checksum FROM awcms_schema_migrations ORDER BY migration_name
  `;
}

export type MigrateResult = {
  executed: string[];
  skipped: string[];
};

/**
 * Jalankan semua migration pending secara berurutan.
 * Drift checksum = error (koreksi harus migration baru, bukan edit lama).
 */
export async function migrateLatest(sql: Sql, dir: string): Promise<MigrateResult> {
  const files = await loadMigrationFiles(dir);
  const plan = planMigrations(files, await readLedger(sql));
  if (plan.drifted.length > 0) {
    const names = plan.drifted.map((d) => d.name).join(", ");
    throw new Error(
      `Checksum drift terdeteksi pada migration yang sudah applied: ${names}. ` +
        `Jangan mengubah migration lama — buat migration koreksi baru.`
    );
  }
  const executed: string[] = [];
  for (const file of plan.pending) {
    await sql.begin(async (tx) => {
      await tx.unsafe(file.content);
      await tx`
        INSERT INTO awcms_schema_migrations (migration_name, checksum)
        VALUES (${file.name}, ${file.checksum})
      `;
    });
    executed.push(file.name);
  }
  return { executed, skipped: plan.applied };
}
