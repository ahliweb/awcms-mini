import test from "node:test";
import assert from "node:assert/strict";

import { buildPluginRlsStatements, createPluginRepository } from "../../src/db/plugin-adapter.mjs";

// Unit test untuk bagian yang tidak butuh DB nyata:
// - buildPluginRlsStatements: pure function, hanya string manipulation
// - createPluginRepository: verifikasi factory menghasilkan object dengan method yang benar
//
// Integration test RLS (negative test) membutuhkan DB nyata dan dipisah ke test terpisah.

test("plugin adapter: buildPluginRlsStatements (default) — enable+force+drop×2+create = 5 statement", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects");
  assert.equal(stmts.length, 5, "Harus menghasilkan 5 SQL statement (idempotent: 2 drop policy)");
});

test("plugin adapter: buildPluginRlsStatements — enable & force RLS", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects");
  assert.ok(stmts[0].includes("enable row level security"));
  assert.ok(stmts[0].includes("sikesra.subjects"));
  assert.ok(stmts[1].includes("force row level security"));
});

test("plugin adapter: buildPluginRlsStatements — idempotent (drop policy lama & baru)", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects").join("\n");
  assert.match(stmts, /drop policy if exists plugin_user_isolation on sikesra\.subjects/);
  assert.match(stmts, /drop policy if exists plugin_access on sikesra\.subjects/);
});

test("plugin adapter: buildPluginRlsStatements (default) — policy creator-only", () => {
  const policy = buildPluginRlsStatements("sikesra", "subjects").at(-1);
  assert.ok(policy.includes("create policy plugin_access"));
  assert.ok(policy.includes("sikesra.subjects.created_by = current_setting('app.current_user_id', true)"));
  // Tanpa opsi: tidak ada admin bypass / region.
  assert.ok(!policy.includes("app.is_admin"), "default tidak boleh admin bypass");
  assert.ok(!policy.includes("user_administrative_region_assignments"), "default tidak boleh region");
});

test("plugin adapter: buildPluginRlsStatements (assignment) — creator OR admin OR region (#353)", () => {
  const policy = buildPluginRlsStatements("sikesra", "subjects", {
    regionColumn: "administrative_region_id",
    adminBypass: true,
  }).at(-1);
  // Creator
  assert.match(policy, /sikesra\.subjects\.created_by = current_setting\('app\.current_user_id', true\)/);
  // Admin bypass
  assert.match(policy, /current_setting\('app\.is_admin', true\) = 'true'/);
  // Region assignment, NULL-safe + penugasan aktif (ends_at is null)
  assert.match(policy, /sikesra\.subjects\.administrative_region_id is not null/);
  assert.match(policy, /user_administrative_region_assignments ura/);
  assert.match(policy, /ura\.administrative_region_id = sikesra\.subjects\.administrative_region_id/);
  assert.match(policy, /ura\.ends_at is null/);
});

test("plugin adapter: buildPluginRlsStatements — memakai schema + tableName yang diberikan", () => {
  const stmts = buildPluginRlsStatements("satu_sehat", "pasien");
  for (const stmt of stmts) {
    if (stmt.includes("table") || stmt.includes("policy")) {
      assert.ok(
        stmt.includes("satu_sehat.pasien"),
        `Statement "${stmt}" harus menyebut "satu_sehat.pasien"`,
      );
    }
  }
});

test("plugin adapter: createPluginRepository menghasilkan object dengan semua method", () => {
  const repo = createPluginRepository("sikesra", "subjects");

  assert.ok(typeof repo.findById === "function", "Harus ada method findById");
  assert.ok(typeof repo.findAll === "function", "Harus ada method findAll");
  assert.ok(typeof repo.insert === "function", "Harus ada method insert");
  assert.ok(typeof repo.softDelete === "function", "Harus ada method softDelete");
  assert.ok(typeof repo.update === "function", "Harus ada method update");
});

test("plugin adapter: createPluginRepository berbeda schema/tabel tidak sharing state", () => {
  const repoA = createPluginRepository("sikesra", "subjects");
  const repoB = createPluginRepository("satu_sehat", "pasien");

  // Kedua repo harus merupakan object berbeda (factory, bukan singleton)
  assert.notStrictEqual(repoA, repoB);
});
