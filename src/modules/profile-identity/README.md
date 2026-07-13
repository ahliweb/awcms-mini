# Profile Identity

Foundation dari Issue 2.2 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 2.2 — Add Central Profile Schema), dilengkapi penuh oleh Issue #748 (epic `platform-evolution` #738, Wave 2) menjadi siklus hidup party (person/organization) kanonik: CRUD lengkap, identifier/alamat/channel effective-dated, relasi generik party-to-party, deteksi duplikat, dan workflow merge approval-gated.

## Scope tabel

- `awcms_mini_profiles` — profile kanonik person/organization, soft delete, `merged_into_profile_id` untuk hasil merge, `status` (`active`/`inactive`/`merged` — `merged` hanya di-set oleh eksekusi merge, tidak bisa lewat `PATCH`).
- `awcms_mini_profile_identifiers` — identifier sensitif (email/phone/whatsapp/national_id/tax_id/external_code), dedup lewat `value_hash` (unique parsial per tenant+type selama belum soft-deleted), `masked_value` untuk tampilan aman, plus (Issue #748) `provenance` (`self_reported`/`verified_by_staff`/`imported`/`system_generated`), `verified_at`/`verified_by`, `valid_from`/`valid_until`.
- `awcms_mini_profile_channels` — preferensi channel komunikasi, mengacu ke `profile_identifiers` (tidak menduplikasi nilai sensitif); `is_default` ADALAH flag "preferred channel per type"; plus (Issue #748) `valid_from`/`valid_until`, `verified_at`/`verified_by`.
- `awcms_mini_profile_addresses` — alamat per profile; plus (Issue #748) `valid_from`/`valid_until`.
- `awcms_mini_profile_entity_links` — tautan profile ke entity modul lain (`module_key`, `entity_type`, `entity_id`), unique per entity agar tidak ambigu tertaut ke lebih dari satu profile. Ini adalah set referensi yang direpoint saat merge dieksekusi.
- `awcms_mini_profile_relationships` (BARU, Issue #748) — relasi party-to-party effective-dated, generik: `relationship_type` adalah teks bebas (dinormalisasi snake_case, TIDAK ada CHECK enum peran bisnis seperti customer/supplier/employee). Record perwakilan resmi (authorized representative) hanyalah baris relasi dengan `is_authorized_representative = true` + `representation_scope` bebas — konsep struktural/legal yang berlaku lintas domain bisnis, bukan peran domain yang di-hardcode.
- `awcms_mini_profile_duplicate_candidates` (BARU, Issue #748) — kandidat duplikat: `match_basis` (`deterministic_identifier`/`heuristic_name_similarity`/`heuristic_combined`), `match_score`, `match_reasons` (jsonb, selalu explainable — bukan skor mentah), `status` (`pending`/`confirmed_duplicate`/`not_duplicate`). Pasangan profile disimpan terurut (`profile_id_a < profile_id_b`) agar tidak dobel.
- `awcms_mini_profile_merge_requests` — request merge dua profile (`source` = loser, `target` = survivor), `source_profile_id <> target_profile_id` (constraint DB + `domain/merge.ts`); plus (Issue #748) `requires_approval`, `field_conflict_snapshot`, `reference_impact_snapshot`, `duplicate_candidate_id`, `executed_at`/`executed_by`.
- `awcms_mini_profile_merge_history` (BARU, Issue #748) — **append-only, immutable**, terpisah dari `merge_requests` yang mutable statusnya. Mencatat survivor/loser, snapshot field-conflict/reference-impact saat eksekusi, dan jumlah entity link yang direpoint — dasar untuk operator menalar/memulihkan efek praktis merge yang keliru (lihat §Strategi pemulihan merge di bawah).
- `awcms_mini_profile_audit_logs` — append-only, dideklarasikan sejak migration 003 tapi **tidak pernah ditulis oleh kode aplikasi** (dead schema) — audit high-risk sesungguhnya memakai `logging` module's `recordAuditEvent`/`awcms_mini_audit_events` (lihat semua endpoint di modul ini). Dibiarkan apa adanya (di luar scope Issue #748), hanya `reporting` module yang masih membaca `COUNT(*)`-nya sebagai proxy generik.

Skema dasar di `sql/003_awcms_mini_central_profile_management_schema.sql`; ekstensi Issue #748 di `sql/059_awcms_mini_profile_identity_party_lifecycle_schema.sql` (juga menutup gap `FORCE ROW LEVEL SECURITY` yang belum ada pada 7 tabel migration 003). Seluruh tabel tenant-scoped memakai `ENABLE`+`FORCE ROW LEVEL SECURITY` (lihat `docs/awcms-mini/04_erd_data_dictionary.md` §RLS standard).

## Domain logic

- `domain/identifier.ts` — `normalizeIdentifier`, `hashIdentifier` (`sha256:<hex>`, dedup key), `maskIdentifier` (nilai aman untuk response/log).
- `domain/identifier-lifecycle.ts` (Issue #748) — provenance/validity-window validation untuk identifier.
- `domain/party-validation.ts` (Issue #748) — validasi create/update party (termasuk larangan set `status: merged` lewat update).
- `domain/address-channel-validation.ts` (Issue #748) — validasi create address/channel effective-dated.
- `domain/relationship.ts` (Issue #748) — `validateRelationshipType`/`normalizeRelationshipType`: format snake_case, TOLAK kata peran bisnis yang di-hardcode (customer/supplier/employee/dst.) sebagai guard defensif terhadap regresi ke domain-specific role di base ini.
- `domain/duplicate-detection.ts` (Issue #748) — `nameSimilarityScore` (Sorensen-Dice bigram, tanpa dependency ML), `buildIdentifierMatchReason`, `combineMatchBasis`, `orderProfilePair`. Selalu explainable, tidak pernah auto-merge dari skor semata.
- `domain/merge.ts` — `assertMergeRequestIsValid` (source ≠ target); plus (Issue #748) `assertSameTenant`/`CrossTenantMergeError` (**wajib dipanggil ulang tepat sebelum operasi merge/match nyata**, tidak pernah mempercayai tenant id yang dibawa row lama), `computeFieldConflicts`, `computeRequiresApproval` (selalu `true` — lihat §Approval merge).
- `domain/projection.ts` (Issue #748) — tiga kontrak proyeksi eksplisit allow-list: `PartyFullDTO` (internal), `PartyMaskedAdminDTO` (API admin — tanpa `tenantId`/actor id), `PartyPublicSafeDTO` (3 field: `id`/`profileType`/`displayName`, `null` untuk profile soft-deleted/merged/inactive).
- `domain/lifecycle-validation.ts` (Issue 10.1) — `validateDeleteReasonRequestBody`.

## Application layer

`application/party-directory.ts` (CRUD+list/search), `identifier-directory.ts`, `address-directory.ts`, `channel-directory.ts`, `relationship-directory.ts`, `duplicate-candidate-directory.ts` (scan on-demand + review), `merge-workflow.ts` (create/decide/execute), `party-directory-port-adapter.ts` (capability port).

## API (Issue #748 — CRUD lengkap, bukan lagi hanya lifecycle)

- `GET/POST /api/v1/profiles`, `GET/PATCH/DELETE /api/v1/profiles/{id}`, `POST /api/v1/profiles/{id}/restore`, `POST /api/v1/profiles/{id}/purge` — party CRUD + lifecycle.
- `GET/POST /api/v1/profiles/{id}/identifiers`, `PATCH/DELETE .../identifiers/{identifierId}` — identifier selalu masked di response (tidak ada endpoint reveal raw value pada issue ini, sama seperti `identifier_masked_reveal` audit action migration 003 yang juga belum pernah diimplementasikan — kapabilitas reveal tetap fitur terpisah untuk masa depan).
- `GET/POST /api/v1/profiles/{id}/addresses`, `DELETE .../addresses/{addressId}`.
- `GET/POST /api/v1/profiles/{id}/channels`, `DELETE .../channels/{channelId}`.
- `GET/POST /api/v1/profiles/{id}/relationships`, `DELETE .../relationships/{relationshipId}` (end relationship, bukan hard delete).
- `POST /api/v1/profiles/{id}/duplicate-candidates/scan` — scan on-demand (bukan job terjadwal — lihat `duplicate-candidate-directory.ts`'s header untuk alasan).
- `GET /api/v1/profile-duplicate-candidates`, `POST /api/v1/profile-duplicate-candidates/{id}/review` — path top-level terpisah (bukan nested `/profiles/...`) supaya tidak pernah bentrok dengan route dinamis `/profiles/{id}`.
- `GET/POST /api/v1/profile-merge-requests`, `GET /api/v1/profile-merge-requests/{id}`, `POST .../decisions` (approve/reject), `POST .../execute` — semua path top-level dengan alasan yang sama.

## Merge workflow (Issue #748)

1. **Create** (`profile_merge.create`) — `sourceProfileId` (loser) + `targetProfileId` (survivor) + `reason`. Menghitung dan menyimpan snapshot `field_conflict_snapshot` (field yang berbeda antar profile — hanya untuk review, base ini tidak punya UI pick-and-choose per field; nilai survivor yang selalu bertahan) dan `reference_impact_snapshot` (jumlah `awcms_mini_profile_entity_links` per module/entity type yang akan direpoint).
2. **Approval** (`profile_merge.approve`) — **setiap** merge di base ini wajib approval (`computeRequiresApproval()` selalu `true` — superset ketat dari "hanya merge high-risk butuh approval", menghindari heuristik risiko yang bisa keliru). Guard self-approval generik (`identity-access/domain/access-control.ts`) mencegah requester menyetujui request-nya sendiri.
3. **Execute** (`profile_merge.merge`, action ABAC baru) — high-risk: `Idempotency-Key` wajib, plus row lock (`SELECT ... FOR UPDATE`) pada `merge_requests` yang menyerialisasi eksekusi konkuren kedua (idempotency key BEDA sekalipun) sehingga panggilan kedua melihat `status = 'completed'` dan mengembalikan hasil yang sudah ada, bukan mengeksekusi ulang. **Tenant loser & survivor divalidasi ulang tepat di titik eksekusi** (`assertSameTenant`), bukan mempercayai apa pun yang tersimpan di request — lihat §Keamanan cross-tenant di bawah.

Efek eksekusi: `awcms_mini_profile_entity_links` milik loser direpoint ke survivor (baris yang akan bentrok dengan link survivor yang sudah ada dihapus sebagai duplikat murni), loser di-soft-delete dengan `status = 'merged'` + `merged_into_profile_id`, baris `awcms_mini_profile_merge_history` immutable ditulis, dan event domain `awcms-mini.profile-identity.profile.merged` dipublikasi lewat outbox `domain_event_runtime` (Issue #742) — lihat §Capability & event di bawah.

### Strategi pemulihan merge

Merge **tidak hard-delete** — loser tetap ada sebagai baris soft-deleted dengan `merged_into_profile_id`. Untuk menalar/memulihkan efek merge yang keliru: (1) baca `awcms_mini_profile_merge_history` untuk survivor/loser, snapshot konflik/impact, dan jumlah link yang direpoint; (2) `awcms_mini_profile_entity_links` yang direpoint masih bisa diidentifikasi lewat `module_key`/`entity_type`/`entity_id` yang sama, tinggal profile_id-nya sudah berubah; (3) un-merge OTOMATIS penuh **tidak** disediakan pada issue ini (butuh menulis ulang setiap link + memulihkan loser secara manual/terarah) — jejak audit di atas adalah yang dibutuhkan operator untuk melakukannya secara terarah, bukan tombol "undo" satu klik.

## Keamanan cross-tenant (persyaratan eksplisit Issue #748)

**Cross-tenant matching/merge dilarang keras.** Ini ditegakkan di DUA lapis:

1. RLS (`FORCE ROW LEVEL SECURITY`) — koneksi role aplikasi biasa tidak akan pernah melihat baris tenant lain sama sekali.
2. `domain/merge.ts`'s `assertSameTenant`/`CrossTenantMergeError` — dipanggil ulang di `application/merge-workflow.ts`'s `createMergeRequest` DAN `executeMergeRequest`, terhadap baris yang di-fetch ulang di dalam transaksi yang sama, tidak pernah mempercayai tenant id yang dibawa objek lama. `fetchPartyForMerge` sengaja TIDAK memfilter `tenant_id` di `WHERE`-nya (mengandalkan RLS untuk jalur normal) justru supaya lapis kedua ini genuinely teruji lewat test terhadap koneksi privileged (bypass RLS) — lihat `tests/integration/profile-identity.integration.test.ts`'s test "application-layer guard: assertSameTenant/CrossTenantMergeError fires even when RLS is bypassed".

`duplicate-candidate-directory.ts`'s scan juga selalu ter-scope `tenant_id` yang sama pada kedua sisi query — tidak ada jalur yang membandingkan profile lintas tenant.

## Capability & event (Issue #748, ADR-0011)

- `_shared/ports/party-directory-port.ts` (`PartyDirectoryPort`) — `exists`/`resolveSummary`/`resolveMergeSurvivor` (mengikuti rantai `merged_into_profile_id`)/`resolvePublicSafeSummary`. Implementasi konkret: `application/party-directory-port-adapter.ts`. Belum ada consumer in-repo (didaftarkan lebih dulu sebelum consumer nyata, sama seperti presiden `legal-hold-guard-port.ts`).
- Domain event `awcms-mini.profile-identity.profile.merged` (via `domain_event_runtime`'s `appendDomainEvent`) — push-based complement untuk `resolveMergeSurvivor` yang pull-based; payload `{mergeRequestId, survivorProfileId, loserProfileId, entityLinksRepointedCount}`.

## Business role bukan hardcoded (persyaratan eksplisit Issue #748)

Tidak ada tabel/kolom/enum di modul ini yang mengenkode peran bisnis kontekstual (customer/supplier/employee/donor/merchant/student/patient). `relationship_type` adalah teks bebas tervalidasi format saja; `domain/relationship.ts` bahkan menolak secara eksplisit beberapa kata peran bisnis yang jelas sebagai guard defensif. Aplikasi turunan bebas membangun semantik domain-spesifik DI ATAS relasi generik ini.

## Metrics (Issue #748)

`profile_identity_party_lifecycle_total` (create/update/archive/restore), `profile_identity_duplicate_candidate_total` (by match basis + status), `profile_identity_merge_total` (by outcome) — lihat `src/lib/observability/metrics-port.ts`'s `METRIC_DEFINITIONS`. Semua label berasal dari enum kode tetap (tidak pernah id/nama/nilai identifier).

## Lifecycle endpoints (Issue 10.1 — demonstrasi audit trail awal)

`DELETE /api/v1/profiles/{id}`, `POST /api/v1/profiles/{id}/restore`, `POST /api/v1/profiles/{id}/purge` sudah ada sejak Issue 10.1 sebagai demonstrasi audit trail; sekarang menjadi bagian dari CRUD lengkap Issue #748 alih-alih endpoint lifecycle-only yang berdiri sendiri.

## Soft delete

`awcms_mini_profiles`, `awcms_mini_profile_identifiers`, `awcms_mini_profile_channels`, dan `awcms_mini_profile_addresses` memakai konvensi soft delete standar (lihat `src/modules/_shared/soft-delete.ts`). `awcms_mini_profile_entity_links` dan `awcms_mini_profile_merge_requests` tidak soft delete (link/request bersifat point-in-time). `awcms_mini_profile_relationships` memakai `status: 'active'/'ended'` (bukan soft delete) — relasi yang berakhir tetap ada sebagai catatan historis. `awcms_mini_profile_duplicate_candidates` dan `awcms_mini_profile_merge_history` tidak soft delete (immutable/point-in-time). `awcms_mini_profile_audit_logs` append-only — tidak ada soft delete maupun update.

## Admin UI

`/admin/profile-identity` (list/search/create party), `/admin/profile-identity/{id}` (detail: identifier/alamat/channel/relasi/duplicate-candidate untuk party ini, mulai merge), `/admin/profile-identity/merge-requests` (antrian review merge: approve/reject/execute). Lingkup UI mengutamakan operasi inti — beberapa field lanjutan (mis. province/postal code alamat) tersedia lewat API tapi belum semuanya punya field form tersendiri di setiap layar (peningkatan lanjutan).

## Belum tersedia (di luar scope Issue #748)

Endpoint reveal identifier mentah (raw value), un-merge otomatis, pencarian full-text (masih substring `ILIKE`), dan business role/entitas domain (customer/supplier/dll.) — semuanya sengaja di luar scope, lihat masing-masing bagian di atas untuk penjelasan.
