// SSO Tahap 1 (ADR-024 / DL-022, #351): skema `auth.sso_providers` +
// `auth.sso_identities` dengan RLS.
//
// Konteks: awcms-mini = single-tenant → TANPA kolom `tenant_id` (awcms
// multi-tenant menambahkannya + isolasi per-tenant). SSO MELENGKAPI auth
// internal (JWT/claims + RBAC/ABAC/RLS tetap otoritas); tabel ini hanya
// menyimpan konfigurasi provider + tautan identitas eksternal↔user internal.
//
// Keamanan (standar SSO §6/§8):
//   - `client_secret_enc` WAJIB terenkripsi (AES-256-GCM, pola
//     src/security/totp.mjs) — JANGAN simpan secret IdP mentah.
//   - RLS (ADR-015) di kedua tabel + `force row level security` agar owner
//     (role yang menjalankan migrasi) pun tunduk RLS — konsisten migrasi 040.
//
// Policy:
//   - sso_providers  = konfigurasi admin-only (baca/tulis hanya bila
//     app.is_admin='true'); user biasa tak boleh melihat secret/issuer.
//   - sso_identities = per-user (user lihat tautan miliknya) + admin bypass.
//
// Set konteks RLS: src/db/plugin-adapter.mjs withUserContext / setPluginDbContext.

import { sql } from "kysely";

export const SSO_SCHEMA = "auth";
export const SSO_PROVIDERS_TABLE = "sso_providers";
export const SSO_IDENTITIES_TABLE = "sso_identities";

export const SSO_PROVIDERS_COLUMNS = [
  "id",
  "kind",
  "display_name",
  "issuer",
  "client_id",
  "client_secret_enc",
  "jwks_uri",
  "authorization_endpoint",
  "token_endpoint",
  "scopes",
  "claim_mappings",
  "allow_jit",
  "allowed_email_domains",
  "enabled",
  "created_at",
  "updated_at",
  "created_by",
  "deleted_at",
];

export const SSO_IDENTITIES_COLUMNS = [
  "id",
  "user_id",
  "provider_id",
  "subject_external",
  "email_external",
  "linked_at",
  "last_login_at",
  "created_at",
  "updated_at",
  "deleted_at",
];

// RLS: konfigurasi provider = admin-only (no per-user akses).
export function buildSsoProvidersRlsStatements() {
  const qualified = `${SSO_SCHEMA}.${SSO_PROVIDERS_TABLE}`;
  return [
    `alter table ${qualified} enable row level security`,
    `alter table ${qualified} force row level security`,
    `create policy rls_sso_providers_admin_only on ${qualified}
       using (current_setting('app.is_admin', true) = 'true')`,
  ];
}

// RLS: tautan identitas = per-user (user_id match) ATAU admin bypass.
export function buildSsoIdentitiesRlsStatements() {
  const qualified = `${SSO_SCHEMA}.${SSO_IDENTITIES_TABLE}`;
  return [
    `alter table ${qualified} enable row level security`,
    `alter table ${qualified} force row level security`,
    `create policy rls_sso_identities_per_user on ${qualified}
       using (
         user_id::text = current_setting('app.current_user_id', true)
         or current_setting('app.is_admin', true) = 'true'
       )`,
  ];
}

export async function up(db) {
  await sql.raw(`create schema if not exists ${SSO_SCHEMA}`).execute(db);

  // ------------------------------------------------------------------
  // auth.sso_providers — konfigurasi provider SSO (admin-only)
  // ------------------------------------------------------------------
  await db.schema
    .withSchema(SSO_SCHEMA)
    .createTable(SSO_PROVIDERS_TABLE)
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("kind", "varchar(16)", (column) =>
      column.notNull().check(sql`kind in ('oidc', 'saml')`),
    )
    .addColumn("display_name", "text", (column) => column.notNull())
    .addColumn("issuer", "text", (column) => column.notNull())
    .addColumn("client_id", "text", (column) => column.notNull())
    .addColumn("client_secret_enc", "text") // terenkripsi (AES-256-GCM); nullable utk klien publik/PKCE
    .addColumn("jwks_uri", "text")
    .addColumn("authorization_endpoint", "text")
    .addColumn("token_endpoint", "text")
    .addColumn("scopes", sql`text[]`, (column) =>
      column.notNull().defaultTo(sql`array['openid','email','profile']::text[]`),
    )
    .addColumn("claim_mappings", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("allow_jit", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("allowed_email_domains", sql`text[]`)
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("created_by", "varchar(64)")
    .addColumn("deleted_at", "timestamptz")
    .execute();

  await db.schema
    .withSchema(SSO_SCHEMA)
    .createIndex("sso_providers_enabled_index")
    .on(SSO_PROVIDERS_TABLE)
    .column("enabled")
    .where(sql`deleted_at is null`)
    .execute();

  await db.schema
    .withSchema(SSO_SCHEMA)
    .createIndex("sso_providers_issuer_unique")
    .on(SSO_PROVIDERS_TABLE)
    .column("issuer")
    .unique()
    .where(sql`deleted_at is null`)
    .execute();

  // ------------------------------------------------------------------
  // auth.sso_identities — tautan identitas eksternal ↔ user internal (per-user)
  // ------------------------------------------------------------------
  await db.schema
    .withSchema(SSO_SCHEMA)
    .createTable(SSO_IDENTITIES_TABLE)
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) =>
      column.notNull().references("public.users.id").onDelete("cascade"),
    )
    .addColumn("provider_id", "varchar(64)", (column) =>
      column.notNull().references("auth.sso_providers.id").onDelete("cascade"),
    )
    .addColumn("subject_external", "text", (column) => column.notNull())
    .addColumn("email_external", "text")
    .addColumn("linked_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_login_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .execute();

  // Satu subject IdP hanya boleh tertaut sekali per provider (cegah duplikasi).
  await db.schema
    .withSchema(SSO_SCHEMA)
    .createIndex("sso_identities_provider_subject_unique")
    .on(SSO_IDENTITIES_TABLE)
    .columns(["provider_id", "subject_external"])
    .unique()
    .where(sql`deleted_at is null`)
    .execute();

  await db.schema
    .withSchema(SSO_SCHEMA)
    .createIndex("sso_identities_user_id_index")
    .on(SSO_IDENTITIES_TABLE)
    .column("user_id")
    .execute();

  // RLS
  for (const stmt of buildSsoProvidersRlsStatements()) {
    await sql.raw(stmt).execute(db);
  }
  for (const stmt of buildSsoIdentitiesRlsStatements()) {
    await sql.raw(stmt).execute(db);
  }
}

export async function down(db) {
  await sql
    .raw(`drop policy if exists rls_sso_identities_per_user on ${SSO_SCHEMA}.${SSO_IDENTITIES_TABLE}`)
    .execute(db);
  await sql
    .raw(`drop policy if exists rls_sso_providers_admin_only on ${SSO_SCHEMA}.${SSO_PROVIDERS_TABLE}`)
    .execute(db);

  await db.schema
    .withSchema(SSO_SCHEMA)
    .dropIndex("sso_identities_user_id_index")
    .ifExists()
    .execute();
  await db.schema
    .withSchema(SSO_SCHEMA)
    .dropIndex("sso_identities_provider_subject_unique")
    .ifExists()
    .execute();
  await db.schema.withSchema(SSO_SCHEMA).dropTable(SSO_IDENTITIES_TABLE).ifExists().execute();

  await db.schema
    .withSchema(SSO_SCHEMA)
    .dropIndex("sso_providers_issuer_unique")
    .ifExists()
    .execute();
  await db.schema
    .withSchema(SSO_SCHEMA)
    .dropIndex("sso_providers_enabled_index")
    .ifExists()
    .execute();
  await db.schema.withSchema(SSO_SCHEMA).dropTable(SSO_PROVIDERS_TABLE).ifExists().execute();
  // Catatan: schema `auth` sengaja TIDAK di-drop (dapat dipakai objek auth lain).
}
