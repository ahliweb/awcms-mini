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

## Belum tersedia

Endpoint REST (resolve/create/merge), event AsyncAPI, dan integrasi workflow approval untuk merge high-risk belum ada pada tahap ini — Issue 2.2 murni scope skema + domain logic murni. Approval merge sesungguhnya menyusul saat Issue 11.1 (Workflow Approval Engine) tersedia.

## Soft delete

`awcms_mini_profiles`, `awcms_mini_profile_identifiers`, `awcms_mini_profile_channels`, dan `awcms_mini_profile_addresses` memakai konvensi soft delete standar (lihat `src/modules/_shared/soft-delete.ts`). `awcms_mini_profile_entity_links` dan `awcms_mini_profile_merge_requests` tidak soft delete (link/request bersifat point-in-time). `awcms_mini_profile_audit_logs` append-only — tidak ada soft delete maupun update.
