#!/usr/bin/env node
// Fitness Function FF6: Cek RLS aktif pada tabel per-user yang wajib (ADR-015, #310)
// Jalankan: node scripts/check-rls-coverage.mjs
// Keluar dengan kode 1 (fail) jika ada tabel wajib yang belum ber-RLS.

import { createDatabase, destroyDatabase } from "../src/db/index.mjs";
import { sql } from "kysely";

// Tabel yang WAJIB ber-RLS (dari migration 040_rls_per_user_tables.mjs)
// Tambahkan di sini setiap kali ada tabel sensitif baru.
const REQUIRED_RLS_TABLES = [
  // Core per-user tables
  { schema: "public", table: "sessions" },
  { schema: "public", table: "login_security_events" },
  { schema: "public", table: "security_events" },
  { schema: "public", table: "totp_credentials" },
  { schema: "public", table: "recovery_codes" },
  { schema: "public", table: "password_reset_tokens" },
  { schema: "public", table: "edge_api_refresh_tokens" },
  // Plugin tables (di-enforce oleh buildPluginRlsStatements di migrate.mjs masing-masing plugin)
  { schema: "sikesra", table: "subjects" },
  { schema: "sikesra", table: "records" },
  { schema: "sikesra", table: "record_documents" },
  { schema: "satu_sehat_kobar", table: "patients" },
  { schema: "satu_sehat_kobar", table: "encounters" },
  { schema: "satu_sehat_kobar", table: "sync_logs" },
];

async function checkRlsCoverage() {
  const db = createDatabase();

  try {
    // Query pg_tables + pg_policies untuk cek status RLS
    const rlsStatus = await sql`
      select
        schemaname as schema,
        tablename as "table",
        rowsecurity as rls_enabled,
        forcerowsecurity as rls_forced
      from pg_tables
      where (schemaname, tablename) in (
        select unnest(array[${sql.join(REQUIRED_RLS_TABLES.map((t) => t.schema), sql`, `)}]::text[]),
               unnest(array[${sql.join(REQUIRED_RLS_TABLES.map((t) => t.table), sql`, `)}]::text[])
      )
    `.execute(db);

    const statusMap = new Map(rlsStatus.rows.map((r) => [`${r.schema}.${r.table}`, r]));

    let hasFailed = false;
    const lines = [];

    for (const { schema, table } of REQUIRED_RLS_TABLES) {
      const key = `${schema}.${table}`;
      const row = statusMap.get(key);

      if (!row) {
        lines.push(`  MISSING  ${key} — tabel tidak ditemukan di database`);
        hasFailed = true;
      } else if (!row.rls_enabled) {
        lines.push(`  FAIL     ${key} — RLS tidak aktif (rowsecurity=false)`);
        hasFailed = true;
      } else if (!row.rls_forced) {
        lines.push(`  WARN     ${key} — RLS aktif tapi tidak forced (forcerowsecurity=false)`);
        // force RLS sangat dianjurkan tapi tidak block (bisa superuser bypass)
      } else {
        lines.push(`  OK       ${key}`);
      }
    }

    console.log("FF6 — RLS Coverage Check");
    console.log("=".repeat(50));
    for (const line of lines) {
      console.log(line);
    }
    console.log("=".repeat(50));

    if (hasFailed) {
      console.error(`\nFF6 FAIL: Ada ${lines.filter((l) => l.includes("FAIL") || l.includes("MISSING")).length} tabel wajib yang belum ber-RLS.`);
      console.error("Jalankan: pnpm db:migrate latest — untuk menerapkan migration 040_rls_per_user_tables.mjs");
      process.exit(1);
    }

    console.log("\nFF6 PASS: Semua tabel wajib sudah ber-RLS.");
    process.exit(0);
  } finally {
    await destroyDatabase();
  }
}

checkRlsCoverage().catch((err) => {
  console.error("FF6 ERROR:", err.message);
  process.exit(1);
});
