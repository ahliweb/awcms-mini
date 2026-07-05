# Profile Identity

Implementasi Issue 2.2 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 2.2 — Add Central Profile Schema).

## Scope

- `awcms_mini_profiles` — profile kanonik person/organization, soft delete, `merged_into_profile_id` untuk hasil merge.
- `awcms_mini_profile_identifiers` — identifier sensitif (email/phone/whatsapp/national_id/tax_id/external_code), dedup lewat `value_hash` (unique parsial per tenant+type selama belum soft-deleted), `masked_value` untuk tampilan aman.
- `awcms_mini_profile_channels` — preferensi channel komunikasi, mengacu ke `profile_identifiers` (tidak menduplikasi nilai sensitif).
- `awcms_mini_profile_addresses` — alamat per profile.
- `awcms_mini_profile_entity_links` — tautan profile ke entity modul lain (`module_key`, `entity_type`, `entity_id`), unique per entity agar tidak ambigu tertaut ke lebih dari satu profile.
- `awcms_mini_profile_merge_requests` — request merge dua profile, `source_profile_id <> target_profile_id` (constraint DB + `domain/merge.ts`).
- `awcms_mini_profile_audit_logs` — append-only (tanpa soft delete), mencatat perubahan/akses profile termasuk reveal identifier ter-mask.

Skema ada di `sql/003_awcms_mini_central_profile_management_schema.sql`. Seluruh tabel tenant-scoped memakai RLS (lihat `docs/awcms-mini/04_erd_data_dictionary.md` §RLS standard).

## Domain logic

- `domain/identifier.ts` — `normalizeIdentifier`, `hashIdentifier` (`sha256:<hex>`, dedup key), `maskIdentifier` (nilai aman untuk response/log).
- `domain/merge.ts` — `assertMergeRequestIsValid` (source tidak boleh sama dengan target).
- `domain/lifecycle-validation.ts` (Issue 10.1) — `validateDeleteReasonRequestBody`: validasi body `{ reason: string }` untuk `DELETE /profiles/{id}`.

## Lifecycle endpoints (Issue 10.1 — demonstrasi audit trail)

Tiga endpoint **lifecycle-only**, sengaja setipis mungkin, ditambahkan semata untuk membuktikan audit trail (`awcms_mini_audit_events`, lihat `src/modules/logging/README.md`) bekerja end-to-end pada resource nyata:

- `DELETE /api/v1/profiles/{id}` (`src/pages/api/v1/profiles/[id].ts`) — guard `profile_identity.profile_management.delete`. Body `{ reason: string }` wajib non-empty → `delete_reason`. 404 (bukan 200 no-op) bila profile tidak ada atau sudah soft-deleted. Audit `action:"delete"`, `severity:"warning"`.
- `POST /api/v1/profiles/{id}/restore` (`src/pages/api/v1/profiles/[id]/restore.ts`) — guard `.restore` (action baru, lihat `src/modules/identity-access/domain/access-control.ts`). 404 bila profile tidak sedang soft-deleted. Audit `action:"restore"`, `severity:"warning"`.
- `POST /api/v1/profiles/{id}/purge` (`src/pages/api/v1/profiles/[id]/purge.ts`) — guard `.purge` (action baru). Hard `DELETE` sungguhan; **wajib** sudah soft-deleted (400 `PURGE_REQUIRES_SOFT_DELETE` bila belum). `awcms_mini_identities`, `awcms_mini_profile_identifiers`, `awcms_mini_profile_channels`, `awcms_mini_profile_addresses`, `awcms_mini_profile_entity_links`, dan `awcms_mini_profile_merge_requests` mereferensikan `profile_id` tanpa `ON DELETE CASCADE` — pelanggaran FK (Postgres `23503`) ditangkap lewat `tx.savepoint(...)` (bukan langsung pada transaction terluar, supaya ABAC decision log dan audit event yang sudah ditulis tidak ikut ter-rollback) dan diterjemahkan ke `409 PURGE_BLOCKED_BY_DEPENDENTS` yang bersih, bukan error DB mentah. Audit ditulis **setelah** hasil diketahui (sukses atau blocked), `severity:"critical"` pada kedua kasus.

**Belum ada** (dan sengaja di luar scope issue ini): `POST /profiles` (create), `PATCH /profiles/{id}` (update), `GET /profiles`/`GET /profiles/{id}` (list/detail) — Issue 2.2 hanya membangun skema + domain logic, tanpa endpoint live sama sekali; issue ini menambah **hanya** tiga endpoint lifecycle di atas untuk membuktikan audit trail bekerja pada data nyata, bukan mulai membangun profile CRUD penuh. CRUD lengkap tetap backlog.

## Belum tersedia

Endpoint REST resolve/create/merge/list/update, event AsyncAPI, dan integrasi workflow approval untuk merge high-risk belum ada pada tahap ini. Approval merge sesungguhnya menyusul saat Issue 11.1 (Workflow Approval Engine) tersedia.

## Soft delete

`awcms_mini_profiles`, `awcms_mini_profile_identifiers`, `awcms_mini_profile_channels`, dan `awcms_mini_profile_addresses` memakai konvensi soft delete standar (lihat `src/modules/_shared/soft-delete.ts`). `awcms_mini_profile_entity_links` dan `awcms_mini_profile_merge_requests` tidak soft delete (link/request bersifat point-in-time). `awcms_mini_profile_audit_logs` append-only — tidak ada soft delete maupun update.
