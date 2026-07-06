# Form Drafts

Implementasi Issue #484 — server-side draft persistence untuk reusable
wizard pattern (Issue #479/#480,
`docs/awcms-mini/examples/wizard-form-pattern.md` §Server-side draft:
follow-up, bukan MVP). Deliberately deferred sampai ada bukti nyata
kebutuhannya: #482 (contoh pemakaian derived module) dan #483 (fixture
nyata di admin shell) lebih dulu landed, baru maintainer meng-unblock issue
ini dengan pilot plan konkret.

## Scope

Satu tabel generik, domain-agnostic: `awcms_mini_form_drafts`
(`sql/019_awcms_mini_form_drafts_schema.sql`) — `tenant_id`, `module_key`,
`wizard_key`, `resource_type`, `resource_id` (nullable, `text` — bukan
`uuid`, disamakan dengan `awcms_mini_workflow_instances`/
`awcms_mini_audit_events.resource_id` supaya draft bisa menunjuk resource
yang belum ada atau identifier non-UUID), `current_step`, `payload` (jsonb),
`status` (`draft → submitted | abandoned | expired`), `expires_at`, kolom
soft-delete standar (`deleted_at`/`deleted_by`/`delete_reason` — tanpa
`restored_at`/`restored_by`, draft adalah scratch state, bukan resource
yang restore-nya bermakna).

Modul ini **tidak tahu apa isi payload-nya** — itu keputusan modul domain
turunan sepenuhnya. Satu-satunya kontrak yang ditegakkan di sini:
`module_key`/`wizard_key`/`resource_type` harus format lowercase
snake_case (`^[a-z][a-z0-9_]{1,63}$`, dicek constraint SQL **dan**
validator domain), `payload` maksimum 32KB serialized, dan `payload` tidak
boleh mengandung field yang menyerupai secret (`password`, `token`,
`secret`, `credential`, `apiKey`, `privateKey` — dicek rekursif di semua
kedalaman nesting, case-insensitive, toleran terhadap separator umum).

## Endpoint publik

Bearer session atau cookie SSR (`authorizeInTransaction`/
`resolveAuthInputs`, `identity-access/application/access-guard.ts`), guard
`form_drafts.draft.{read,create,update,delete}` — permission generik,
**tidak** digerbangi per `module_key` pembuat draft (RLS sudah
mengisolasi per tenant; ABAC di sini menjawab "bisakah user ini memakai
API form-drafts sama sekali", bukan "bisakah user ini menyentuh draft milik
modul X").

- **`GET /api/v1/form-drafts`** — daftar draft tenant (non-deleted, limit
  100, terbaru dulu), filter opsional `?moduleKey=&wizardKey=&status=`.
- **`POST /api/v1/form-drafts`** — buat draft baru. Bukan idempotent
  (tidak wajib `Idempotency-Key`) — worst-case retry jaringan adalah satu
  baris scratch tambahan yang bisa dihapus user, bukan efek domain.
- **`GET /api/v1/form-drafts/{id}`** — baca satu draft (resume-on-load).
- **`PATCH /api/v1/form-drafts/{id}`** — perbarui `currentStep`/`payload`/
  `expiresAt`. Hanya draft `status = 'draft'` yang bisa diedit — draft yang
  sudah submitted/abandoned/expired mengembalikan `404` (riwayat, bukan
  resource hidup). Idempotent secara alami (payload sama → state akhir
  sama), tidak butuh `Idempotency-Key`.
- **`DELETE /api/v1/form-drafts/{id}`** — soft-delete ("abandon"). `reason`
  opsional (beda dari `DELETE /api/v1/profiles/{id}` yang mewajibkannya —
  draft adalah scratch state berisiko rendah, bukan record bisnis).
  Idempotent-safe: memanggil ulang pada draft yang sudah dihapus
  mengembalikan `404`, bukan menulis ulang `deleted_at`.
- **`POST /api/v1/form-drafts/{id}/submit`** — transisi `draft →
submitted`. Memakai ulang action ABAC `update` (bukan action baru — sama
  seperti `workflow.approval.approve` dipakai untuk approve **dan**
  reject). **High-risk**: wajib `Idempotency-Key`, pola replay/conflict
  identik `workflows/tasks/{id}/decisions.ts`.

## Kenapa create/update/delete tidak butuh Idempotency-Key, tapi submit butuh

`create` menambah baris scratch bernilai rendah — retry jaringan
menghasilkan draft duplikat yang bisa dihapus user, bukan efek domain.
`update`/`delete` idempotent secara struktural (payload sama → state akhir
sama; `deleted_at IS NULL` guard mencegah tulis ulang). `submit` adalah
transisi status yang benar-benar berarti (dan pada modul domain turunan
nyata kemungkinan memicu efek lanjutan) — retry jaringan yang menyebabkan
submit ganda adalah bug nyata, bukan sekadar baris scratch berlebih,
sehingga wajib idempotency key sesuai doc 10 §Idempotency wrapper rules.

## Retensi/expiry

Dua tahap terpisah (`application/form-draft-purge.ts`,
`bun run form-drafts:purge` — mirip `logs:audit:purge`, Issue #447):

1. **`expireOverdueFormDrafts`** — draft `status='draft'` yang
   `expires_at`-nya lewat ditransisikan ke `status='expired'` (transisi
   lunak, bukan delete — baris + payload tetap ada untuk audit/debug,
   hanya tidak lagi resumable/editable).
2. **`purgeExpiredFormDrafts`** — hapus fisik draft `expired`/`abandoned`
   yang lebih tua dari retention cutoff (`updated_at`, default 30 hari,
   override `--retention-days=<n>` atau env `FORM_DRAFT_RETENTION_DAYS`).

Tidak ada FK child pada tabel ini, jadi DELETE fisik di tahap 2 tidak
pernah memutus foreign key (alasan sama seperti `audit_events`, migration
011). Kedua tahap mencatat aksinya sendiri sebagai audit event
(`recordAuditEvent`, `action: "expire"`/`"purge"`) — tidak pernah purge
diam-diam, sama seperti `audit-purge.ts`.

## Pilot: `admin/examples/wizard.astro`

`moduleKey: "admin_examples"`, `wizardKey: "wizard_fixture"`,
`resourceType: "fixture"` — SSR meng-query draft aktif via application
layer langsung (pola sama seperti `admin/index.astro`'s dashboard
reports, bukan round-trip HTTP ke API sendiri), client script menyimpan
progress via `POST`/`PATCH` setiap kali step berpindah, dan submit final
memakai `Idempotency-Key` nyata. Lihat komentar di berkas itu untuk detail
wiring; `wizard-derived-module-example.md` (Issue #482) menunjukkan pola
yang sama untuk modul domain turunan sungguhan.
