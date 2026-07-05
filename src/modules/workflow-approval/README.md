# Workflow Approval

Implementasi Issue 11.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 11.1 — Add Workflow Approval Engine).

## Scope

Generic multi-step approval engine, tanpa istilah/aksi bisnis domain apa pun (base ini tidak punya POS cancel, Coretax export, atau warehouse transfer — semuanya domain-specific dan sudah berulang kali dikeluarkan dari base ini di issue-issue sebelumnya). Empat tabel persis sesuai doc 04 §Workflow (migration `012_awcms_mini_workflow_approval_schema.sql`):

1. **`awcms_mini_workflow_definitions`** — template workflow per tenant. `workflow_key` unik per tenant (partial unique index `WHERE deleted_at IS NULL`, pola dedup yang sama seperti `office_code`/`profile_identifiers`). Kolom `steps` (jsonb) adalah daftar langkah terurut, mis. `[{"stepOrder":1,"name":"Manager approval"}]` — divalidasi di domain logic (`validateWorkflowSteps`), bukan constraint SQL. "Steps" pada scope issue **bukan** tabel ke-5 — ia melekat pada satu definition.
2. **`awcms_mini_workflow_instances`** — satu proses approval berjalan untuk satu resource (`resource_type`/`resource_id`, `resource_id` bertipe `text` mengikuti pola `awcms_mini_audit_events.resource_id`). `status`: `pending → approved | rejected | cancelled`. `current_step_order` menunjuk step yang sedang menunggu keputusan.
3. **`awcms_mini_workflow_tasks`** — satu task per step per instance (`status`: `pending → completed | skipped`).
4. **`awcms_mini_workflow_decisions`** — append-only, satu baris per keputusan (`decision`: `approve`/`reject`, `decided_by_tenant_user_id`, `reason` opsional). RLS sama seperti `awcms_mini_abac_decision_logs`/`awcms_mini_audit_events`: satu policy `tenant_isolation`, tidak ada `UPDATE` yang pernah dijalankan aplikasi terhadap tabel ini.

## Kenapa tidak ada endpoint publik "create definition" / "start instance"

Doc 17 §Registry module & activity hanya memberi `workflow_approval.approval: read, approve` — **tidak ada** `create`/`configure`. Membangun endpoint publik untuk membuat definition atau memulai instance berarti menciptakan permission/aksi yang tidak disahkan doc 17, persis jenis penambahan tak berdasar yang dihindari repo ini berulang kali (bandingkan: Issue 6.3 tidak membangun dispatcher R2 sungguhan; Issue 10.1 hanya membangun 3 endpoint lifecycle profile tipis, bukan CRUD penuh).

Sebagai gantinya:

- `application/workflow-instance.ts` → `startWorkflowInstance(tx, params)` adalah fungsi aplikasi **internal-only** (bukan dipanggil route publik manapun). Ia membaca `steps` definition, membuat instance (`status: 'pending'`, `current_step_order: 1`), dan task pertama (`step_order: 1`, `status: 'pending'`). Melempar error bila definition tidak ada, tidak aktif, atau soft-deleted.
- Dipakai oleh: (a) kode domain masa depan pada aplikasi turunan yang menggerbangi aksi bisnis nyata (mis. POS cancel/Coretax export), dan (b) fixture test/verifikasi langsung — pola yang sama seperti Issue 9.1 (SQL langsung untuk office/tenant-user kedua) dan Issue 10.1 (SQL langsung untuk profile test).
- Workflow definition sendiri juga hanya dibuat lewat `INSERT` langsung pada saat verifikasi/test (tidak ada endpoint `POST /workflows/definitions`), untuk alasan yang sama.

## Endpoint publik (persis yang disahkan doc 17: "decision API")

Bearer session (`Authorization: Bearer <token>` + header `X-AWCMS-Mini-Tenant-ID`), pola identik dengan `GET /api/v1/logs/audit` dan `POST /api/v1/sync/conflicts/{id}/resolve`: `resolveTenantContext` → `fetchGrantedPermissionKeys` → `evaluateAccess` (default deny) → `recordDecisionLog` (dicatat untuk allow maupun deny).

- **`GET /api/v1/workflows/tasks`** — guard `{ moduleKey: "workflow", activityCode: "approval", action: "read" }`. Daftar task `status = 'pending'` milik tenant, join instance (`workflowDefinitionId`, `resourceType`, `resourceId`, `requestedByTenantUserId`, `currentStepOrder`) dan definition (`workflowKey`, `workflowName`) untuk konteks. `LIMIT 100 ORDER BY created_at ASC`.
- **`POST /api/v1/workflows/tasks/{id}/decisions`** — guard `{ moduleKey: "workflow", activityCode: "approval", action: "approve" }` (satu action untuk **kedua** nilai `decision` — "approve" dan "reject" — sama seperti `sync_storage.conflict_resolution.approve` yang menggerbangi seluruh `POST /sync/conflicts/{id}/resolve` apa pun `resolution`-nya; permission di sini adalah kapabilitas "memutuskan", bukan hanya menyetujui). Body: `{ decision: "approve" | "reject", reason?: string }`.

  Modul key yang dipakai di guard sengaja `"workflow"` (bukan `"workflow_approval"` dari doc 17) — konsisten dengan preseden `"logging"`/`"reporting"` yang juga memendekkan module key doc 17 (`observability_logging`/`management_reporting`) di kode. Seed permission migration `012` memakai `('workflow', 'approval', ...)` mengikuti pola yang sama.

## Self-approval guard — dipakai ulang, bukan mekanisme baru

`evaluateAccess` (`src/modules/identity-access/domain/access-control.ts`, ditambahkan Issue 2.4) sudah punya cek generik:

```ts
if (request.action === "approve" && requestedBy === context.tenantUserId) {
  return {
    allowed: false,
    reason: "Self-approval is not allowed.",
    matchedPolicy: "self_approval_deny"
  };
}
```

Endpoint decision di sini **memanggil ulang** mekanisme yang sudah ada ini — tidak ada guard baru. Kuncinya: `decisions.ts` melakukan `SELECT` task+instance (untuk `requested_by_tenant_user_id`) **sebelum** memanggil `evaluateAccess`, supaya `resourceAttributes.requestedByTenantUserId` terisi nilai yang benar untuk dibandingkan terhadap `context.tenantUserId` (doc 17 Policy #7).

## Alur keputusan → transisi

`domain/workflow-transition.ts` (`evaluateDecisionOutcome`, pure function, tanpa I/O):

- `reject` di step manapun → instance langsung `rejected`, tidak ada task baru.
- `approve` saat `currentStepOrder < totalSteps` → instance tetap `pending`, task baru dibuat di `currentStepOrder + 1`.
- `approve` di step terakhir (`currentStepOrder === totalSteps`) → instance `approved`, tidak ada task baru.

`decisions.ts` menjalankan urutan: 404 bila task tidak ada; `INSERT` ke `awcms_mini_workflow_decisions`; tandai task `completed`; panggil `evaluateDecisionOutcome`; `UPDATE` `status`/`current_step_order` instance; bila ada `nextStepOrder`, `INSERT` task berikutnya berstatus `pending`; `recordAuditEvent` (`src/modules/logging/application/audit-log.ts`, `resourceType: "workflow_instance"`, `severity: "warning"`).

## Idempotency

`POST /workflows/tasks/{id}/decisions` adalah mutation high-risk — doc 10 §Idempotency wrapper rules eksplisit menyebut "workflow decision" wajib `Idempotency-Key`. Tidak ada endpoint lain di base ini yang sudah mengimplementasikan mekanisme header+store ini di kode (base ini belum punya POS posting/transfer/dll yang butuh idempotency), tapi OpenAPI baseline **sudah** menyediakan parameter `IdempotencyKey` sejak awal tanpa pernah dipakai — endpoint ini adalah konsumen pertamanya.

`src/modules/_shared/idempotency.ts` (helper generik, dipakai bersama modul manapun di masa depan) + tabel generik `awcms_mini_idempotency_keys` (migration `012`, kolom: `request_scope`, `idempotency_key`, `request_hash`, `response_status`, `response_body`, unique `(tenant_id, request_scope, idempotency_key)`). Alur: key sama + hash sama → replay response tersimpan; key sama + hash beda → `409 IDEMPOTENCY_CONFLICT`; key baru → jalankan mutation lalu simpan hasil.

Catatan: doc 04 §Table ownership matrix mencantumkan `awcms_mini_idempotency_keys` di grup ilustratif "Sales POS" — itu mencerminkan domain contoh tempat ERD pertama kali memperkenalkannya, bukan kepemilikan eksklusif; doc 16 (§Idempotency store, dokumen integrasi backend generik, bukan spesifik domain) mendeskripsikannya sebagai infrastruktur lintas modul. Ditambahkan di sini sebagai infrastruktur generik yang dapat dipakai ulang mutation high-risk masa depan.

Selain mekanisme key+hash, task yang statusnya sudah bukan `pending` (sudah diputuskan) mengembalikan `409 IDEMPOTENCY_CONFLICT` juga — lapis keamanan tambahan yang sama seperti preseden `POST /sync/conflicts/{id}/resolve` (cek status alih-alih hanya mengandalkan header).

## Belum tersedia

- Tidak ada endpoint publik create-definition/start-instance (lihat di atas) — backlog untuk aplikasi turunan yang punya aksi bisnis nyata untuk digerbangi.
- Tidak ada UI approval inbox (`/admin/workflows`) — di luar scope issue ini (murni backend/API); lihat skill `awcms-mini-ui-screen` untuk issue UI masa depan.
- Retention/purge job untuk `awcms_mini_idempotency_keys` (doc 04: retensi 7–30 hari) belum ada — pembersihan berkala menjadi backlog terpisah.
- `status: 'skipped'` pada `awcms_mini_workflow_tasks` dan `status: 'cancelled'` pada instance dideklarasikan di constraint tapi belum ada jalur kode yang menghasilkannya (tidak ada kebutuhan nyata di base ini saat ini) — disediakan agar skema tidak perlu migration lanjutan begitu ada kebutuhan skip/cancel.
