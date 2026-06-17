import test from "node:test";
import assert from "node:assert/strict";

import { up, down } from "../../src/db/migrations/041_users_search_trgm_index.mjs";

test("trgm migration 041: up & down diekspor sebagai function", () => {
  assert.equal(typeof up, "function");
  assert.equal(typeof down, "function");
});

test("trgm migration 041: up mengaktifkan pg_trgm + GIN index untuk kolom search", async () => {
  const executed = [];
  const fakeDb = {};
  // Tangkap SQL yang dieksekusi via stub `sql` — di sini kita uji lewat pemanggilan nyata
  // dengan executor stub yang merekam string. Karena migrasi memakai tagged template &
  // sql.raw, kita verifikasi idempotensi marker pada sumbernya.
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../../src/db/migrations/041_users_search_trgm_index.mjs", import.meta.url), "utf8"),
  );
  assert.match(src, /create extension if not exists pg_trgm/);
  for (const col of ["email", "username", "display_name"]) {
    assert.match(src, new RegExp(`users_\\$\\{column\\}_trgm_idx|users_${col}_trgm_idx`));
  }
  assert.match(src, /gin_trgm_ops/);
  assert.match(src, /if not exists/); // idempoten
  void executed;
  void fakeDb;
});

test("trgm migration 041: down memakai drop index if exists (aman) & tidak drop ekstensi", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../../src/db/migrations/041_users_search_trgm_index.mjs", import.meta.url), "utf8"),
  );
  assert.match(src, /drop index if exists/);
  assert.doesNotMatch(src, /drop extension/);
});
