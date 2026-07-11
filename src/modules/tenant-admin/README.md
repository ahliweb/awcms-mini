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
- `POST /api/v1/setup/initialize` — public, tanpa auth (memang begitu — belum ada identity untuk login sebelum tenant pertama dibuat). Satu transaksi atomik: klaim lock (`INSERT ... ON CONFLICT DO NOTHING` — mencegah race condition dua request bersamaan), buat tenant, `SET LOCAL app.current_tenant_id` begitu tenant ID diketahui, lalu buat `tenant_settings`, office (`head_office`), profile + identity + tenant_user owner, role `owner` (`is_system=true`) berisi **seluruh** permission yang ada di katalog (`awcms_mini_permissions`) saat itu, assignment owner → role owner, dan terakhir mengunci `setup_state`. Orkestrasi ini (Issue #680, epic #679) hidup di `application/platform-bootstrap.ts`'s `bootstrapPlatformTenant` — sebuah composition-root function eksplisit yang menulis ke tabel `profile_identity`/`identity_access` DALAM transaksi yang sama, dipanggil langsung oleh route handler. Ini SENGAJA bukan module `dependencies` edge (menaruh kebutuhan panggilan satu-kali ini sebagai `dependencies: ["profile_identity", "identity_access"]` dulu menciptakan cycle nyata dengan kedua modul itu — lihat `.claude/skills/awcms-mini-module-management/SKILL.md`'s §Registry-wide DAG validator).

Skema ada di `sql/006_awcms_mini_setup_wizard_schema.sql`.

Sejak Issue #683 (epic #679), route ini connect ke database lewat
`getSetupDatabaseClient()` — role Postgres khusus `awcms_mini_setup`
(`SETUP_DATABASE_URL`, opsional, fallback ke `DATABASE_URL`/role
`awcms_mini_app` bila tidak di-set), BUKAN `getDatabaseClient()` seperti
sebelumnya. Defense-in-depth di atas kunci singleton `awcms_mini_setup_state`
yang sudah ada — bila kredensial `awcms_mini_app` yang melayani request
biasa suatu saat bocor, penyerang tetap tidak bisa membuat tenant nakal
lewat endpoint ini (butuh kredensial `awcms_mini_setup` yang terpisah).
Lihat `sql/045_awcms_mini_db_role_separation.sql`'s header untuk matriks
grant lengkap dan `docs/awcms-mini/18_configuration_env_reference.md`
§Model role database untuk penjelasan keempat role.

## Domain logic

`domain/setup-validation.ts` — `validateSetupInitializeInput` (pure, murni): memvalidasi field wajib non-kosong dan panjang minimum password (kebijakan generik, 8 karakter — "Password wajib memenuhi policy" doc 03). Tidak memvalidasi format `tenantCode`/`officeCode` lebih jauh; keunikan ditegakkan oleh constraint database.

## Settings management (admin screen)

`GET/PATCH /api/v1/settings` dan layar admin `/admin/settings` — sebelumnya `tenant_name`, `legal_name`, `default_locale`, `default_theme` (di `awcms_mini_tenants`) dan `timezone`, `feature_flags` (di `awcms_mini_tenant_settings`) hanya bisa diisi sekali oleh Setup Wizard, tidak pernah bisa diubah lagi.

- `GET /api/v1/settings` menggabungkan kedua tabel dalam satu response (`fetchTenantSettings` di `application/tenant-settings-directory.ts`, dipakai bersama endpoint JSON dan SSR `/admin/settings` — pola yang sama seperti `user-directory.ts`/`sync-directory.ts`).
- `PATCH /api/v1/settings` menerima subset field apa pun (`tenantName`, `legalName` — boleh `null` untuk mengosongkan, `defaultLocale` — enum `id/en/ms/ar` sesuai doc 04 ERD, `defaultTheme` — enum `light/dark/system`, `timezone`, `featureFlags` — harus JSON object). Guard `tenant_admin.tenant_settings.{read,update}`, diseed di `sql/015_awcms_mini_tenant_settings_management_permission_schema.sql` (tanpa perubahan schema — semua kolom sudah ada sejak migrasi 002).
- **`awcms_mini_tenants` sengaja RLS-free** (lihat `scripts/security-readiness.ts` `RLS_FREE_TABLES` — tabel ini adalah root tenant itu sendiri, `id`-nya adalah tenant id, tidak ada kolom `tenant_id` terpisah untuk dijadikan kunci policy). Endpoint mengandalkan `WHERE id = <tenantId dari sesi>` secara eksplisit di setiap `UPDATE`, bukan RLS, untuk membatasi update pada tenant milik sendiri — dites langsung di test integrasi (`tenant B tidak pernah berubah saat tenant A update`).
- **Menutup gap dokumentasi lama**: `default_locale`/`default_theme` sebenarnya kolom di `awcms_mini_tenants` (doc 04 §ERD), bukan `awcms_mini_tenant_settings` — beberapa referensi lama (`ThemeToggle.astro`, doc 14 §Theming, doc 18 §Presedensi) salah menyebut tabelnya; sudah diperbaiki bersamaan dengan perubahan ini.
- **Tema default tenant kini benar-benar dipakai**: skrip resolusi tema no-flash di `AdminLayout.astro` (`<head>` inline script) sekarang fallback ke `awcms_mini_tenants.default_theme` (via `define:vars`) ketika browser belum pernah memilih tema secara personal di localStorage — sebelumnya hardcode `"system"` dan kolom `default_theme` tidak pernah benar-benar dibaca kode mana pun.

## Belum tersedia

Seed ABAC policy row (`awcms_mini_abac_policies` tetap kosong — evaluator memakai aturan generik bawaan di `evaluateAccess`, bukan policy row dari DB), event AsyncAPI `tenant.created`/`access.assignment` (doc 17, menyusul modul Observability/Logging), dan role selain `owner` (role tambahan seperti Admin/Member generik menyusul kebutuhan nyata, bukan diseed otomatis). Manajemen office (`awcms_mini_offices`) juga belum punya endpoint — permission `tenant_admin.office_management.{read,create,update}` sudah diseed sejak Issue 2.4 tetapi tanpa konsumen; kantor selain head office (dibuat Setup Wizard) hanya bisa ditambah langsung ke DB pada tahap ini.

## Soft delete

`awcms_mini_offices` dan `awcms_mini_physical_locations` memakai konvensi soft delete standar (`deleted_at`/`deleted_by`/`delete_reason`/`restored_at`/`restored_by`, lihat `src/modules/_shared/soft-delete.ts`). `awcms_mini_tenants` **tidak** soft delete — status inactive/suspended menggantikan penghapusan tenant.
