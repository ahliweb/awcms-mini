# Tenant Admin

Implementasi Issue 2.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 2.1 — Add Tenant and Office Schema).

## Scope

- `awcms_mini_tenants` — root multi-tenant, unique `tenant_code`, lifecycle `status` (active/inactive/suspended).
- `awcms_mini_offices` — hierarki kantor/cabang/gudang per tenant, unique `(tenant_id, office_code)` selama belum soft-deleted, RLS tenant isolation.
- `awcms_mini_physical_locations` — detail alamat per office, soft delete, RLS tenant isolation.
- `awcms_mini_tenant_settings` — konfigurasi 1:1 per tenant (timezone, feature flag generik), RLS tenant isolation.

Skema ada di `sql/002_awcms_mini_tenant_office_schema.sql`. Lihat `docs/awcms-mini/04_erd_data_dictionary.md` §Data dictionary untuk kolom lengkap dan §RLS standard untuk pola isolasi tenant.

## Belum tersedia

Endpoint REST, event AsyncAPI, dan logic domain/application/infrastructure belum ada pada tahap ini — Issue 2.1 murni scope skema database. API tenant-admin menyusul saat Issue 12.1 (Setup Wizard, `docs/awcms-mini/06_github_issues_detail.md` §Issue 12.1) diimplementasikan setelah Issue 2.1, 2.3, dan 2.4 selesai (lihat doc 06 §Koreksi urutan sprint).

## Soft delete

`awcms_mini_offices` dan `awcms_mini_physical_locations` memakai konvensi soft delete standar (`deleted_at`/`deleted_by`/`delete_reason`/`restored_at`/`restored_by`, lihat `src/modules/_shared/soft-delete.ts`). `awcms_mini_tenants` **tidak** soft delete — status inactive/suspended menggantikan penghapusan tenant.
