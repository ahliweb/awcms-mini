import test from "node:test";
import assert from "node:assert/strict";

import {
  searchUsers,
  toUserSearchDto,
  USER_SEARCH_COLUMNS,
  USER_SEARCH_SORT_FIELDS,
} from "../../src/search/users-search.mjs";

// Stub Kysely-like query builder: merekam paginasi/sort & mengembalikan rows canned.
// Callback `where((eb) => ...)` diabaikan (tidak crash); SQL ILIKE nyata diuji di integrasi.
function createStubDb({ rows = [], count = 0 } = {}) {
  const captured = { selectArgs: [], orderBy: [], limit: null, offset: null, fromTables: [] };
  function makeQb() {
    const qb = {
      where() {
        return qb;
      },
      select(arg) {
        captured.selectArgs.push(arg);
        return qb;
      },
      orderBy(field, dir) {
        captured.orderBy.push([field, dir]);
        return qb;
      },
      limit(n) {
        captured.limit = n;
        return qb;
      },
      offset(n) {
        captured.offset = n;
        return qb;
      },
      async executeTakeFirst() {
        return { count };
      },
      async execute() {
        return rows;
      },
    };
    return qb;
  }
  return {
    db: {
      selectFrom(table) {
        captured.fromTables.push(table);
        return makeQb();
      },
    },
    captured,
  };
}

test("users-search: USER_SEARCH_COLUMNS TIDAK mengandung password_hash", () => {
  assert.ok(!USER_SEARCH_COLUMNS.includes("password_hash"), "proyeksi tidak boleh expose password_hash");
  assert.ok(USER_SEARCH_COLUMNS.includes("id") && USER_SEARCH_COLUMNS.includes("email"));
});

test("users-search: toUserSearchDto membuang field sensitif walau row membawanya", () => {
  const dto = toUserSearchDto({
    id: "u1",
    email: "a@b.com",
    username: "budi",
    display_name: "Budi",
    status: "active",
    is_protected: true,
    created_at: "2026-01-01T00:00:00.000Z",
    password_hash: "$2b$RAHASIA",
    data: { secret: "x" },
  });
  assert.equal(dto.id, "u1");
  assert.equal(dto.email, "a@b.com");
  assert.equal(dto.displayName, "Budi");
  assert.equal(dto.isProtected, true);
  assert.ok(!("password_hash" in dto), "DTO tidak boleh punya password_hash");
  assert.ok(!("passwordHash" in dto), "DTO tidak boleh punya passwordHash");
  assert.ok(!("data" in dto), "DTO tidak boleh membocorkan kolom data");
});

test("users-search: toUserSearchDto(null) → null", () => {
  assert.equal(toUserSearchDto(null), undefined ?? null);
});

test("users-search: searchUsers mengembalikan DTO tanpa password_hash + meta paginasi", async () => {
  const { db } = createStubDb({
    rows: [
      { id: "u1", email: "a@b.com", username: "budi", display_name: "Budi", status: "active", is_protected: false, created_at: "2026-01-01T00:00:00.000Z", password_hash: "$2b$LEAK" },
    ],
    count: 41,
  });

  const result = await searchUsers({ q: "budi", page: 2, pageSize: 20 }, { db });

  assert.equal(result.total, 41);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 20);
  assert.equal(result.totalPages, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].email, "a@b.com");
  assert.ok(!("password_hash" in result.items[0]), "hasil search tidak boleh bocor password_hash");
});

test("users-search: paginasi (offset) & sort tie-breaker diterapkan", async () => {
  const { db, captured } = createStubDb({ rows: [], count: 0 });
  await searchUsers({ page: 3, pageSize: 10, sort: { field: "email", dir: "asc" } }, { db });

  assert.equal(captured.limit, 10);
  assert.equal(captured.offset, 20); // (3-1)*10
  // orderBy dipanggil: field utama (email asc) lalu tie-breaker id asc
  assert.deepEqual(captured.orderBy[0], ["email", "asc"]);
  assert.deepEqual(captured.orderBy[1], ["id", "asc"]);
});

test("users-search: sort field di luar whitelist → fallback created_at", async () => {
  const { db, captured } = createStubDb({ rows: [], count: 0 });
  await searchUsers({ sort: { field: "password_hash", dir: "asc" } }, { db });
  assert.equal(captured.orderBy[0][0], "created_at");
  assert.ok(USER_SEARCH_SORT_FIELDS.includes("email") && !USER_SEARCH_SORT_FIELDS.includes("password_hash"));
});
