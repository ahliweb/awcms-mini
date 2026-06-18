import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../../../server/app.mjs";

function makeRequest(path, options = {}) {
  return new Request(`http://localhost:3000${path}`, options);
}

function createSearchOptions({ allowed = true, captureInput, auditCalls } = {}) {
  return {
    resolveActor: () => ({ id: "user_1", status: "active", staff_level: 9 }),
    auditService: {
      async append(entry) {
        if (auditCalls) auditCalls.push(entry);
        return true;
      },
    },
    authorizationService: {
      async evaluate(input) {
        return {
          allowed,
          permission_code: input.context.permission_code,
          matched_rule: allowed ? "test-allow" : "test-deny",
          reason: allowed ? null : { code: "DENY_PERMISSION_MISSING" },
        };
      },
    },
    permissionRepository: {
      async listPermissions() {
        return [
          { id: "perm_admin_users_read", code: "admin.users.read" },
          { id: "perm_sikesra_subject_read", code: "awcms:sikesra:subject:read" },
          { id: "perm_ssk_patient_read", code: "awcms:satu_sehat_kobar:patient:read" },
        ];
      },
    },
    // Inject stub query service (CQRS) — read DTO, tanpa password_hash.
    searchUsers: async (query) => {
      if (captureInput) captureInput(query);
      return {
        items: [{ id: "u1", email: "a@b.com", username: "budi", displayName: "Budi", status: "active", isProtected: false, createdAt: "2026-01-01T00:00:00.000Z" }],
        page: query.page ? Number(query.page) : 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
      };
    },
    searchSubjects: async (query, deps) => {
      if (deps?.onAudit) await deps.onAudit({ q: query.q ?? null, count: 1 });
      return { items: [{ id: "s1", fullName: "Budi", gender: "M", classification: "highly_restricted", createdAt: "2026-01-01T00:00:00.000Z" }], page: 1, pageSize: 20, total: 1, totalPages: 1 };
    },
    searchPatients: async (query, deps) => {
      if (deps?.onAudit) await deps.onAudit({ q: query.q ?? null, count: 1 });
      return { items: [{ id: "p1", fullName: "Siti", gender: "F", classification: "restricted", hasIhs: true, createdAt: "2026-01-01T00:00:00.000Z" }], page: 1, pageSize: 20, total: 1, totalPages: 1 };
    },
  };
}

test("api-v1 search: GET /search/users authorized → 200 + data DTO (tanpa password_hash)", async () => {
  const app = createApp(createSearchOptions());
  const res = await app.fetch(makeRequest("/api/v1/search/users?q=budi"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total, 1);
  assert.equal(body.data.items[0].email, "a@b.com");
  assert.ok(!("password_hash" in body.data.items[0]), "tidak boleh bocor password_hash");
});

test("api-v1 search: GET /search/users meneruskan query (q/page/sort) ke query service", async () => {
  let captured = null;
  const app = createApp(createSearchOptions({ captureInput: (q) => (captured = q) }));
  await app.fetch(makeRequest("/api/v1/search/users?q=budi&page=2&pageSize=10&sortField=email&sortDir=asc"));
  assert.equal(captured.q, "budi");
  assert.equal(captured.page, "2");
  assert.equal(captured.pageSize, "10");
  assert.deepEqual(captured.sort, { field: "email", dir: "asc" });
});

test("api-v1 search: GET /search/users denied (tanpa permission) → 403", async () => {
  const app = createApp(createSearchOptions({ allowed: false }));
  const res = await app.fetch(makeRequest("/api/v1/search/users?q=budi"));
  assert.equal(res.status, 403);
});

test("api-v1 search: GET /search/sikesra/subjects authorized → 200 + DTO tanpa nik + AUDIT", async () => {
  const auditCalls = [];
  const app = createApp(createSearchOptions({ auditCalls }));
  const res = await app.fetch(makeRequest("/api/v1/search/sikesra/subjects?q=budi"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.items[0].fullName, "Budi");
  assert.ok(!("nik_enc" in body.data.items[0]), "tidak boleh bocor nik_enc");
  // Audit pencarian data sensitif WAJIB tercatat
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, "sikesra.subject.search");
  assert.equal(auditCalls[0].metadata.count, 1);
});

test("api-v1 search: GET /search/satusehat/patients authorized → 200 + hasIhs + AUDIT", async () => {
  const auditCalls = [];
  const app = createApp(createSearchOptions({ auditCalls }));
  const res = await app.fetch(makeRequest("/api/v1/search/satusehat/patients?q=siti"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.items[0].hasIhs, true);
  assert.ok(!("ihs_number" in body.data.items[0]), "tidak boleh bocor nilai ihs_number");
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, "satu_sehat_kobar.patient.search");
});

test("api-v1 search: endpoint sensitif denied (tanpa permission) → 403", async () => {
  const app = createApp(createSearchOptions({ allowed: false }));
  const res1 = await app.fetch(makeRequest("/api/v1/search/sikesra/subjects?q=x"));
  const res2 = await app.fetch(makeRequest("/api/v1/search/satusehat/patients?q=x"));
  assert.equal(res1.status, 403);
  assert.equal(res2.status, 403);
});
