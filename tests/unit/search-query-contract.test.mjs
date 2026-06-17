import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSearchQuery,
  buildSearchResult,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../src/search/query-contract.mjs";

test("query-contract: default page=1, pageSize=20, sort created_at desc", () => {
  const q = normalizeSearchQuery({});
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(q.offset, 0);
  assert.deepEqual(q.sort, { field: "created_at", dir: "desc" });
  assert.equal(q.q, null);
});

test("query-contract: q di-trim; kosong → null", () => {
  assert.equal(normalizeSearchQuery({ q: "  budi " }).q, "budi");
  assert.equal(normalizeSearchQuery({ q: "   " }).q, null);
});

test("query-contract: pageSize dibatasi maks 100", () => {
  assert.equal(normalizeSearchQuery({ pageSize: 9999 }).pageSize, MAX_PAGE_SIZE);
  assert.equal(normalizeSearchQuery({ pageSize: 0 }).pageSize, 1);
  assert.equal(normalizeSearchQuery({ pageSize: 50 }).pageSize, 50);
});

test("query-contract: offset dihitung dari page & pageSize", () => {
  const q = normalizeSearchQuery({ page: 3, pageSize: 25 });
  assert.equal(q.offset, 50);
});

test("query-contract: page minimal 1 (negatif/0 → 1)", () => {
  assert.equal(normalizeSearchQuery({ page: -5 }).page, 1);
  assert.equal(normalizeSearchQuery({ page: 0 }).page, 1);
});

test("query-contract: sort field di-whitelist (anti-injection)", () => {
  // field tak diizinkan → fallback ke default
  const q1 = normalizeSearchQuery({ sort: { field: "password_hash; drop table", dir: "asc" } });
  assert.equal(q1.sort.field, "created_at");
  // field diizinkan → dipakai
  const q2 = normalizeSearchQuery({ sort: { field: "email", dir: "asc" } }, { allowedSortFields: ["email", "created_at"] });
  assert.deepEqual(q2.sort, { field: "email", dir: "asc" });
});

test("query-contract: dir hanya asc/desc (default desc)", () => {
  assert.equal(normalizeSearchQuery({ sort: { field: "created_at", dir: "weird" } }).sort.dir, "desc");
  assert.equal(normalizeSearchQuery({ sort: { field: "created_at", dir: "asc" } }).sort.dir, "asc");
});

test("query-contract: buildSearchResult menghitung totalPages", () => {
  const r = buildSearchResult([{ id: 1 }], { page: 1, pageSize: 20, total: 41 });
  assert.equal(r.total, 41);
  assert.equal(r.totalPages, 3);
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 20);
  assert.deepEqual(r.items, [{ id: 1 }]);
});

test("query-contract: buildSearchResult total invalid → fallback ke jumlah items", () => {
  const r = buildSearchResult([{ id: 1 }, { id: 2 }], { page: 1, pageSize: 20, total: NaN });
  assert.equal(r.total, 2);
});
