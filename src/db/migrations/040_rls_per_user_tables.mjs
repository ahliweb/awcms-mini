// RLS enforcement pada tabel per-user yang paling sensitif (ADR-015, #310)
// Konteks: awcms-mini = single-tenant; RLS = defense-in-depth per user.
//
// Policy model:
//   - Regular access: user hanya bisa akses record miliknya (user_id match app.current_user_id)
//   - Admin bypass: bila app.is_admin = 'true', semua record bisa diakses
//     (di-set oleh middleware admin routes, tidak di-set di request user biasa)
//
// Set konteks: src/db/plugin-adapter.mjs setPluginDbContext() + middleware auth (per #317)
// Tabel yang di-enforce: sessions, login_security_events, security_events,
//   totp_credentials, recovery_codes, password_reset_tokens, edge_api_refresh_tokens

import { sql } from "kysely";

// Helper: bangun SQL strings untuk enable RLS + policy per-user + admin bypass
function buildPerUserRlsStatements(tableName, userIdColumn = "user_id") {
  return [
    `alter table public.${tableName} enable row level security`,
    `alter table public.${tableName} force row level security`,
    // Policy per-user: akses jika user_id cocok ATAU admin
    `create policy rls_per_user_isolation on public.${tableName}
       using (
         ${userIdColumn}::text = current_setting('app.current_user_id', true)
         or current_setting('app.is_admin', true) = 'true'
       )`,
  ];
}

export async function up(db) {
  // sessions — user hanya bisa lihat sesi miliknya
  for (const stmt of buildPerUserRlsStatements("sessions", "user_id")) {
    await sql.raw(stmt).execute(db);
  }

  // login_security_events — log login per user
  for (const stmt of buildPerUserRlsStatements("login_security_events", "user_id")) {
    await sql.raw(stmt).execute(db);
  }

  // security_events — event keamanan per user
  for (const stmt of buildPerUserRlsStatements("security_events", "user_id")) {
    await sql.raw(stmt).execute(db);
  }

  // totp_credentials — credential 2FA per user
  for (const stmt of buildPerUserRlsStatements("totp_credentials", "user_id")) {
    await sql.raw(stmt).execute(db);
  }

  // recovery_codes — kode pemulihan 2FA per user
  for (const stmt of buildPerUserRlsStatements("recovery_codes", "user_id")) {
    await sql.raw(stmt).execute(db);
  }

  // password_reset_tokens — token reset password per user
  for (const stmt of buildPerUserRlsStatements("password_reset_tokens", "user_id")) {
    await sql.raw(stmt).execute(db);
  }

  // edge_api_refresh_tokens — token API edge per user
  for (const stmt of buildPerUserRlsStatements("edge_api_refresh_tokens", "user_id")) {
    await sql.raw(stmt).execute(db);
  }
}

export async function down(db) {
  const tables = [
    "sessions",
    "login_security_events",
    "security_events",
    "totp_credentials",
    "recovery_codes",
    "password_reset_tokens",
    "edge_api_refresh_tokens",
  ];

  for (const table of tables) {
    await sql.raw(`drop policy if exists rls_per_user_isolation on public.${table}`).execute(db);
    await sql.raw(`alter table public.${table} disable row level security`).execute(db);
  }
}
