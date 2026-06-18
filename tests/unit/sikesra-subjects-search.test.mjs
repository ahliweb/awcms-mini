import test from "node:test";
import assert from "node:assert/strict";

import {
  searchSubjects,
  toSubjectSearchDto,
  SUBJECT_SEARCH_COLUMNS,
  SUBJECT_SEARCH_SORT_FIELDS,
} from "../../src/plugins/sikesra/search/subjects-search.mjs";

function createStubDb({ rows = [], count = 0 } = {}) {
  const captured = { schema: null, orderBy: [], limit: null, offset: null };
  function makeQb() {
    const qb = {
      where() {
        return qb;
      },
      select() {
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
      withSchema(schema) {
        captured.schema = schema;
        return { selectFrom: () => makeQb() };
      },
    },
    captured,
  };
}

test("sikesra-search: SUBJECT_SEARCH_COLUMNS TIDAK mengandung nik_enc/metadata", () => {
  assert.ok(!SUBJECT_SEARCH_COLUMNS.includes("nik_enc"), "tidak boleh expose nik_enc");
  assert.ok(!SUBJECT_SEARCH_COLUMNS.includes("metadata"), "tidak boleh expose metadata");
  assert.ok(SUBJECT_SEARCH_COLUMNS.includes("id") && SUBJECT_SEARCH_COLUMNS.includes("full_name"));
});

test("sikesra-search: toSubjectSearchDto membuang nik_enc & metadata walau row membawanya", () => {
  const dto = toSubjectSearchDto({
    id: "s1",
    full_name: "Budi Santoso",
    gender: "M",
    classification: "highly_restricted",
    created_at: "2026-01-01T00:00:00.000Z",
    nik_enc: "ENCRYPTED_NIK_LEAK",
    metadata: { secret: "x" },
  });
  assert.equal(dto.id, "s1");
  assert.equal(dto.fullName, "Budi Santoso");
  assert.ok(!("nik_enc" in dto), "DTO tidak boleh punya nik_enc");
  assert.ok(!("nikEnc" in dto), "DTO tidak boleh punya nikEnc");
  assert.ok(!("metadata" in dto), "DTO tidak boleh punya metadata");
});

test("sikesra-search: searchSubjects memakai schema sikesra + DTO tanpa NIK", async () => {
  const { db, captured } = createStubDb({
    rows: [{ id: "s1", full_name: "Budi", gender: "M", classification: "highly_restricted", created_at: "2026-01-01T00:00:00.000Z", nik_enc: "LEAK", metadata: { a: 1 } }],
    count: 5,
  });
  const result = await searchSubjects({ q: "budi", page: 1, pageSize: 20 }, { executor: db });

  assert.equal(captured.schema, "sikesra");
  assert.equal(result.total, 5);
  assert.equal(result.items.length, 1);
  assert.ok(!("nik_enc" in result.items[0]), "hasil search tidak boleh bocor nik_enc");
  assert.ok(!("metadata" in result.items[0]), "hasil search tidak boleh bocor metadata");
});

test("sikesra-search: onAudit dipanggil dengan q & count (audit data sensitif)", async () => {
  const { db } = createStubDb({ rows: [], count: 3 });
  let audited = null;
  await searchSubjects({ q: "x" }, { executor: db, onAudit: (info) => { audited = info; } });
  assert.deepEqual(audited, { q: "x", count: 3 });
});

test("sikesra-search: sort field di luar whitelist → fallback created_at", async () => {
  const { db, captured } = createStubDb({ rows: [], count: 0 });
  await searchSubjects({ sort: { field: "nik_enc", dir: "asc" } }, { executor: db });
  assert.equal(captured.orderBy[0][0], "created_at");
  assert.ok(!SUBJECT_SEARCH_SORT_FIELDS.includes("nik_enc"));
});
