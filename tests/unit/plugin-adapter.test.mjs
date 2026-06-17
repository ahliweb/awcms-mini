import test from "node:test";
import assert from "node:assert/strict";

import { buildPluginRlsStatements, createPluginRepository } from "../../src/db/plugin-adapter.mjs";

// Unit test untuk bagian yang tidak butuh DB nyata:
// - buildPluginRlsStatements: pure function, hanya string manipulation
// - createPluginRepository: verifikasi factory menghasilkan object dengan method yang benar
//
// Integration test RLS (negative test) membutuhkan DB nyata dan dipisah ke test terpisah.

test("plugin adapter: buildPluginRlsStatements menghasilkan 3 SQL string", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects");
  assert.equal(stmts.length, 3, "Harus menghasilkan tepat 3 SQL statement");
});

test("plugin adapter: buildPluginRlsStatements — statement pertama enable RLS", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects");
  assert.ok(
    stmts[0].includes("enable row level security"),
    `Statement pertama harus enable RLS, dapat: "${stmts[0]}"`,
  );
  assert.ok(stmts[0].includes("sikesra.subjects"), 'Harus menyebut "sikesra.subjects"');
});

test("plugin adapter: buildPluginRlsStatements — statement kedua force RLS", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects");
  assert.ok(
    stmts[1].includes("force row level security"),
    `Statement kedua harus force RLS, dapat: "${stmts[1]}"`,
  );
});

test("plugin adapter: buildPluginRlsStatements — statement ketiga create policy isolasi user", () => {
  const stmts = buildPluginRlsStatements("sikesra", "subjects");
  assert.ok(stmts[2].includes("create policy"), 'Statement ketiga harus "create policy"');
  assert.ok(stmts[2].includes("current_setting"), 'Policy harus memakai current_setting');
  assert.ok(stmts[2].includes("app.current_user_id"), 'Policy harus memakai app.current_user_id');
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
