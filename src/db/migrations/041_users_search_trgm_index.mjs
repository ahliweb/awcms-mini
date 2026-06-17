import { sql } from "kysely";

/**
 * Index pencarian untuk CQRS-lite (ADR-023, Tahap 2).
 * Mengaktifkan ekstensi pg_trgm + GIN trigram index pada kolom yang dicari di
 * users-search (email, username, display_name) agar ILIKE '%q%' tidak full scan.
 */

const TRGM_COLUMNS = ["email", "username", "display_name"];

export async function up(db) {
  await sql`create extension if not exists pg_trgm`.execute(db);

  for (const column of TRGM_COLUMNS) {
    await sql
      .raw(`create index if not exists users_${column}_trgm_idx on users using gin (${column} gin_trgm_ops)`)
      .execute(db);
  }
}

export async function down(db) {
  for (const column of TRGM_COLUMNS) {
    await sql.raw(`drop index if exists users_${column}_trgm_idx`).execute(db);
  }
  // Ekstensi pg_trgm sengaja TIDAK di-drop (mungkin dipakai index lain).
}
