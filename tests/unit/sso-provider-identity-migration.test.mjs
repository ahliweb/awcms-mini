import test from "node:test";
import assert from "node:assert/strict";

// Unit test struktur migrasi 043 (SSO Tahap 1, #351). Test integrasi DB nyata
// dijalankan di CI/Docker (RLS via role non-superuser).

import {
  up,
  down,
  SSO_SCHEMA,
  SSO_PROVIDERS_TABLE,
  SSO_IDENTITIES_TABLE,
  SSO_PROVIDERS_COLUMNS,
  SSO_IDENTITIES_COLUMNS,
  buildSsoProvidersRlsStatements,
  buildSsoIdentitiesRlsStatements,
} from "../../src/db/migrations/043_sso_provider_identity_tables.mjs";

test("sso migrasi 043: up & down diekspor", () => {
  assert.equal(typeof up, "function");
  assert.equal(typeof down, "function");
});

test("sso migrasi 043: schema = auth, tabel sesuai standar SSO §8", () => {
  assert.equal(SSO_SCHEMA, "auth");
  assert.equal(SSO_PROVIDERS_TABLE, "sso_providers");
  assert.equal(SSO_IDENTITIES_TABLE, "sso_identities");
});

test("sso migrasi 043: kolom sso_providers mencakup secret terenkripsi + soft-delete", () => {
  for (const col of [
    "id",
    "kind",
    "issuer",
    "client_id",
    "client_secret_enc",
    "scopes",
    "claim_mappings",
    "allow_jit",
    "allowed_email_domains",
    "enabled",
    "deleted_at",
  ]) {
    assert.ok(SSO_PROVIDERS_COLUMNS.includes(col), `sso_providers harus punya kolom ${col}`);
  }
  // Tidak boleh menyimpan secret mentah.
  assert.ok(
    !SSO_PROVIDERS_COLUMNS.includes("client_secret"),
    "DILARANG kolom client_secret mentah — hanya client_secret_enc",
  );
});

test("sso migrasi 043: kolom sso_identities = tautan eksternal↔internal", () => {
  for (const col of ["id", "user_id", "provider_id", "subject_external", "email_external"]) {
    assert.ok(SSO_IDENTITIES_COLUMNS.includes(col), `sso_identities harus punya kolom ${col}`);
  }
});

test("sso migrasi 043: single-tenant — TANPA tenant_id (mini)", () => {
  assert.ok(!SSO_PROVIDERS_COLUMNS.includes("tenant_id"));
  assert.ok(!SSO_IDENTITIES_COLUMNS.includes("tenant_id"));
});

test("sso migrasi 043: RLS providers = admin-only + force RLS", () => {
  const stmts = buildSsoProvidersRlsStatements().join("\n");
  assert.match(stmts, /enable row level security/);
  assert.match(stmts, /force row level security/);
  assert.match(stmts, /current_setting\('app\.is_admin', true\) = 'true'/);
  // Admin-only: TIDAK ada klausa per-user untuk tabel konfigurasi.
  assert.doesNotMatch(stmts, /app\.current_user_id/);
});

test("sso migrasi 043: RLS identities = per-user + admin bypass + force RLS", () => {
  const stmts = buildSsoIdentitiesRlsStatements().join("\n");
  assert.match(stmts, /force row level security/);
  assert.match(stmts, /user_id::text = current_setting\('app\.current_user_id', true\)/);
  assert.match(stmts, /current_setting\('app\.is_admin', true\) = 'true'/);
});
