import test from "node:test";
import assert from "node:assert/strict";

import {
  searchPatients,
  toPatientSearchDto,
  PATIENT_SEARCH_COLUMNS,
  PATIENT_SEARCH_SORT_FIELDS,
} from "../../src/plugins/satu-sehat-kobar/search/patients-search.mjs";

function createStubDb({ rows = [], count = 0 } = {}) {
  const captured = { schema: null, orderBy: [], limit: null, offset: null };
  function makeQb() {
    const qb = {
      where: () => qb,
      select: () => qb,
      orderBy: (f, d) => {
        captured.orderBy.push([f, d]);
        return qb;
      },
      limit: (n) => {
        captured.limit = n;
        return qb;
      },
      offset: (n) => {
        captured.offset = n;
        return qb;
      },
      executeTakeFirst: async () => ({ count }),
      execute: async () => rows,
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

test("satusehat-search: PATIENT_SEARCH_COLUMNS tidak mengandung nik_enc/metadata", () => {
  assert.ok(!PATIENT_SEARCH_COLUMNS.includes("nik_enc"));
  assert.ok(!PATIENT_SEARCH_COLUMNS.includes("metadata"));
});

test("satusehat-search: DTO tidak membocorkan nik_enc, nilai ihs_number, metadata; hanya hasIhs", () => {
  const dto = toPatientSearchDto({
    id: "p1",
    full_name: "Siti",
    gender: "F",
    classification: "restricted",
    ihs_number: "IHS-SECRET-123",
    metadata: { x: 1 },
    nik_enc: "ENC_LEAK",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(dto.id, "p1");
  assert.equal(dto.fullName, "Siti");
  assert.equal(dto.hasIhs, true, "hasIhs true bila ihs_number ada");
  assert.ok(!("ihs_number" in dto), "nilai ihs_number tidak boleh bocor");
  assert.ok(!("nik_enc" in dto), "nik_enc tidak boleh bocor");
  assert.ok(!("metadata" in dto), "metadata tidak boleh bocor");
});

test("satusehat-search: hasIhs false bila ihs_number kosong", () => {
  const dto = toPatientSearchDto({ id: "p2", full_name: "Ali", ihs_number: null });
  assert.equal(dto.hasIhs, false);
});

test("satusehat-search: searchPatients memakai schema satu_sehat_kobar + DTO aman", async () => {
  const { db, captured } = createStubDb({
    rows: [{ id: "p1", full_name: "Siti", gender: "F", classification: "restricted", ihs_number: "IHS-1", created_at: "2026-01-01T00:00:00.000Z", nik_enc: "LEAK" }],
    count: 7,
  });
  const result = await searchPatients({ q: "siti" }, { executor: db });
  assert.equal(captured.schema, "satu_sehat_kobar");
  assert.equal(result.total, 7);
  assert.equal(result.items[0].hasIhs, true);
  assert.ok(!("ihs_number" in result.items[0]));
  assert.ok(!("nik_enc" in result.items[0]));
});

test("satusehat-search: onAudit dipanggil dengan q & count", async () => {
  const { db } = createStubDb({ rows: [], count: 2 });
  let audited = null;
  await searchPatients({ q: "z" }, { executor: db, onAudit: (i) => (audited = i) });
  assert.deepEqual(audited, { q: "z", count: 2 });
});

test("satusehat-search: sort field di luar whitelist → fallback created_at", async () => {
  const { db, captured } = createStubDb({ rows: [], count: 0 });
  await searchPatients({ sort: { field: "ihs_number", dir: "asc" } }, { executor: db });
  assert.equal(captured.orderBy[0][0], "created_at");
  assert.ok(!PATIENT_SEARCH_SORT_FIELDS.includes("ihs_number"));
});
