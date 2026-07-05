# Tenant Admin

Implementasi Issue 2.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 2.1 — Add Tenant and Office Schema) dan Issue 12.1 (§Issue 12.1 — Add Initial Setup Wizard API).

## Scope — Issue 2.1 (Tenant/Office)

- `awcms_mini_tenants` — root multi-tenant, unique `tenant_code`, lifecycle `status` (active/inactive/suspended).
- `awcms_mini_offices` — hierarki kantor/cabang/gudang per tenant, unique `(tenant_id, office_code)` selama belum soft-deleted, RLS tenant isolation.
- `awcms_mini_physical_locations` — detail alamat per office, soft delete, RLS tenant isolation.
- `awcms_mini_tenant_settings` — konfigurasi 1:1 per tenant (timezone, feature flag generik), RLS tenant isolation.

Skema ada di `sql/002_awcms_mini_tenant_office_schema.sql`. Lihat `docs/awcms-mini/04_erd_data_dictionary.md` §Data dictionary untuk kolom lengkap dan §RLS standard untuk pola isolasi tenant.

## Scope — Issue 12.1 (Setup Wizard)

- `awcms_mini_setup_state` — tabel singleton global (`id boolean PRIMARY KEY DEFAULT true`, tanpa `tenant_id`/RLS — belum ada tenant saat setup berjalan). Mengunci setup secara permanen setelah berhasil sekali; `POST /setup/initialize` berikutnya selalu ditolak.
- `GET /api/v1/setup/status` — public, tanpa auth. Mengembalikan `{ locked: false }` atau `{ locked: true, tenantId, lockedAt }`.
- `POST /api/v1/setup/initialize` — public, tanpa auth (memang begitu — belum ada identity untuk login sebelum tenant pertama dibuat). Satu transaksi atomik: klaim lock (`INSERT ... ON CONFLICT DO NOTHING` — mencegah race condition dua request bersamaan), buat tenant, `SET LOCAL app.current_tenant_id` begitu tenant ID diketahui, lalu buat `tenant_settings`, office (`head_office`), profile + identity + tenant_user owner, role `owner` (`is_system=true`) berisi **seluruh** permission yang ada di katalog (`awcms_mini_permissions`) saat itu, assignment owner → role owner, dan terakhir mengunci `setup_state`.

Skema ada di `sql/006_awcms_mini_setup_wizard_schema.sql`.

## Domain logic

`domain/setup-validation.ts` — `validateSetupInitializeInput` (pure, murni): memvalidasi field wajib non-kosong dan panjang minimum password (kebijakan generik, 8 karakter — "Password wajib memenuhi policy" doc 03). Tidak memvalidasi format `tenantCode`/`officeCode` lebih jauh; keunikan ditegakkan oleh constraint database.

## Belum tersedia

Seed ABAC policy row (`awcms_mini_abac_policies` tetap kosong — evaluator memakai aturan generik bawaan di `evaluateAccess`, bukan policy row dari DB), event AsyncAPI `tenant.created`/`access.assignment` (doc 17, menyusul modul Observability/Logging), dan role selain `owner` (role tambahan seperti Admin/Member generik menyusul kebutuhan nyata, bukan diseed otomatis).

## Soft delete

`awcms_mini_offices` dan `awcms_mini_physical_locations` memakai konvensi soft delete standar (`deleted_at`/`deleted_by`/`delete_reason`/`restored_at`/`restored_by`, lihat `src/modules/_shared/soft-delete.ts`). `awcms_mini_tenants` **tidak** soft delete — status inactive/suspended menggantikan penghapusan tenant.
