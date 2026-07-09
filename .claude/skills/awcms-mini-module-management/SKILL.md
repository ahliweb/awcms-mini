---
name: awcms-mini-module-management
description: Kelola/konsumsi sistem Module Management AWCMS-Mini (registry, tenant lifecycle enable/disable, settings, permission sync/status, navigation, job registry, health/readiness). Gunakan saat menambah field descriptor baru (permissions/navigation/settings/jobs/health) di modul lain, saat menyelidiki kenapa suatu modul terlihat degraded/orphaned, atau saat mengubah perilaku enable/disable/settings/health module_management sendiri. Sesuai src/modules/module-management/README.md, epic #510.
---

# AWCMS-Mini — Module Management System

Ikuti `src/modules/module-management/README.md` (sumber kebenaran penuh
per issue #511-#521) dan `docs/awcms-mini/10_template_kode_coding_standard.md`
§Module contract. Skill ini merangkum pola yang **tidak jelas dari
sekadar membaca satu file** — dependency graph, urutan sync, semantik
merge settings, dan makna tiap sinyal health.

## Kapan pakai skill ini vs `awcms-mini-new-module`

`awcms-mini-new-module` = cara **scaffold** modul baru (struktur folder,
descriptor minimal). Skill ini = cara kerja **sistem** yang mengelola
modul yang sudah terdaftar — enable/disable per tenant, settings,
permission sync, navigation, jobs, health. Pakai skill ini saat modulmu
sudah ada dan kamu perlu mendeklarasikan `permissions`/`navigation`/
`settings`/`jobs` di descriptornya, atau saat menyelidiki masalah di
sistem module management itu sendiri.

## "Sync first" — aturan FK yang wajib dipahami

`awcms_mini_tenant_modules`, `_module_settings`, `_module_health_checks`
semua punya FK ke `awcms_mini_modules.module_key`. Mendaftarkan modul di
`src/modules/index.ts` **tidak otomatis** membuat baris registrynya.
Setiap mutasi tenant-scoped yang butuh baris registry ada
(`enableTenantModule`/`disableTenantModule`/`updateModuleSettings`/
`runModuleHealthCheck`) memanggil `syncModuleDescriptors(tx)` sendiri di
awal — **jangan** asumsikan operator sudah menjalankan
`POST /api/v1/modules/sync` manual lebih dulu. Bila menambah mutasi baru
dengan FK serupa, ikuti pola yang sama.

Konsekuensi: `GET /api/v1/modules/{moduleKey}/health`'s sinyal
`db_registry_synced` bisa `fail` di instance yang baru dimigrasikan
(belum pernah ada mutasi tenant-scoped apa pun) — ini **bukan bug**,
laporan yang jujur. `POST .../health/check` men-sync duluan sebagai efek
samping menulis riwayat, jadi bisa menunjukkan hasil `pass` untuk sinyal
yang sama di momen yang sama — asimetri yang disengaja, didokumentasikan
di README modul.

## Dependency graph (enable/disable)

Graph **selalu** dibaca dari `listModules()` (code), **tidak pernah**
dari `awcms_mini_module_dependencies` (cache hasil sync terakhir — bisa
basi). Kode error dari `domain/tenant-module-lifecycle.ts`:

| Kode                                 | Kapan                                                |
| ------------------------------------ | ---------------------------------------------------- |
| `MODULE_NOT_FOUND`                   | Key tidak terdaftar / dinonaktifkan global (code)    |
| `MODULE_ALREADY_ENABLED`/`_DISABLED` | Tidak ada perubahan state                            |
| `MODULE_DEPENDENCY_MISSING`          | Dependency tidak terdaftar sama sekali               |
| `MODULE_DEPENDENCY_DISABLED`         | Dependency nonaktif (global atau tenant ini)         |
| `MODULE_REVERSE_DEPENDENCY_ACTIVE`   | Modul lain yang aktif masih bergantung padanya       |
| `MODULE_DEPENDENCY_CYCLE`            | Circular dependency di graph                         |
| `MODULE_VERSION_INCOMPATIBLE`        | `minAppVersion` modul > versi app saat ini           |
| `CORE_MODULE_CANNOT_BE_DISABLED`     | `isCore: true` — tidak bisa dinonaktifkan, bukan bug |

Modul `isCore: true` (saat ini hanya `module_management` sendiri) tidak
bisa dinonaktifkan — ini pencegah _admin lockout_ utama: kemampuan
mengelola modul lain tidak pernah hilang.

## Tenant module presets (Issue #565, epic #555)

`domain/module-presets.ts` + `application/module-presets.ts`
(`applyModulePreset`) — set state modul tenant sekaligus ke sebuah
"profil" (`online_website`, `news_portal`, `saas_online`, `pos_lan`,
`minimal`), 100% reuse `evaluateModuleEnable`/`evaluateModuleDisable`/
`enableTenantModule`/`disableTenantModule` di atas — **tidak pernah**
menulis `awcms_mini_tenant_modules` langsung. Preset menerapkan enable
DAN disable (bukan cuma enable) — modul yang tidak ada di daftar preset
dan bukan "protected" (`isCore` + closure transitif dependency-nya,
dihitung dinamis lewat `resolveProtectedModuleKeys`) akan di-disable,
leaves-first, skip (bukan force) untuk modul yang masih dibutuhkan modul
lain yang tetap enabled. Idempotent (re-apply = plan kosong). **Baru
service layer** — belum ada endpoint API/UI (scope Issue #566). Detail
lengkap: `module-management/README.md` §Tenant module presets, skill
`awcms-mini-tenant-domain-routing` §Tenant module presets (Issue #565).

## Settings — merge dangkal, bukan replace

`PATCH .../settings` men-**merge dangkal** body ke `tenantOverride` yang
ada (`{ ...before, ...patch }`) — key yang tidak disebut tetap tidak
berubah. Berbeda dari `PATCH /api/v1/settings`'s `featureFlags` (replace
utuh field itu) karena di sini seluruh body request **adalah** resource
settings-nya, bukan satu field bernama di resource lain. Key yang
menyerupai secret (daftar sama `_shared/redaction.ts`'s `REDACTION_KEYS`,
termasuk `credential`) **ditolak saat request** (`400
SETTINGS_SENSITIVE_KEY_REJECTED`), tidak pernah disimpan lalu di-redact
saat dibaca. **Value** berbentuk credential juga ditolak walau key-nya
tidak mencurigakan (`_shared/redaction.ts`'s `findSecretShapedValues` —
JWT, blok PEM private key, AWS access key id, header `Bearer`/`Basic`
mentah, connection string ber-`user:pass@`; sengaja konservatif supaya
label/URL/flag biasa tidak pernah salah tertolak) — `400
SETTINGS_SECRET_SHAPED_VALUE_REJECTED`, pesan error hanya menyebut path
key, tidak pernah value-nya. Berlaku otomatis untuk semua modul yang
pakai `validateModuleSettingsPatch`, tanpa perlu ubah route/modul
masing-masing.

## Permission sync status — jangan auto-fix `orphaned`

`GET /api/v1/modules/{moduleKey}/permissions` (Issue #517) melaporkan
`synced`/`missing`/`orphaned`/`mismatched_description` — **read-only**,
tidak pernah menulis ke `awcms_mini_permissions`. Hanya `module_management`
dan `blog_content` (sejak Issue #543, 36-entry array) yang sudah
mendeklarasikan `permissions` di descriptornya; 9 modul lain (email,
form-drafts, identity-access, logging, profile-identity, reporting,
sync-storage, tenant-admin, workflow-approval) punya permission seed
nyata (dari migration masing-masing) tapi belum ditambahkan ke
descriptor — jadi permission mereka **legitimately** muncul `orphaned`
hari ini, bukan insiden. Jangan hapus baris `awcms_mini_permissions`
berdasarkan laporan ini tanpa keputusan admin eksplisit.

## Health check — GET pasif, POST eksplisit

`GET .../health` = sinyal generik murah saja (registry synced, migrasi
diterapkan, permission/jobs/OpenAPI/AsyncAPI terdokumentasi, settings
valid) — **tidak pernah** memanggil provider eksternal, aman dipanggil
berulang. `POST .../health/check` = sinyal sama **plus** live check ke
provider bila modul punya satu (`email` saat ini, lewat
`resolveEmailProvider().healthCheck()` yang sudah timeout-bounded sejak
Issue #495) — dan menulis riwayat ke `awcms_mini_module_health_checks`.
Menambah provider check baru untuk modul lain: ikuti pola yang sama
(hanya di `POST`, bounded/non-throwing, `detail` selalu string generik
tetap — tidak pernah pesan error mentah).

## Job registry — dokumentasi murni

`ModuleDescriptor.jobs` **tidak pernah** jadi permukaan eksekusi command
dari web — hanya metadata (`command`, `purpose`, `recommendedSchedule`,
`environmentNotes`, `safeInOfflineLan`). Jangan tambah endpoint yang
menjalankan command dari sini; bila eksekusi job dari UI benar-benar
dibutuhkan suatu saat, itu harus fitur terpisah yang dibatasi ketat
(security note eksplisit epic #510).

## Verifikasi

`tests/module-management-*.test.ts` (domain, unit, per Issue) dan
`tests/integration/module-*.integration.test.ts` (API+RLS+audit
end-to-end, real Postgres) — jalankan `bun test` dengan `DATABASE_URL`
sebelum PR yang menyentuh sistem ini dianggap selesai (`bun run check`
tanpa `DATABASE_URL` **melewatkan** semua test integration secara diam-diam).

## Skill terkait

`awcms-mini-new-module` (scaffold modul baru, termasuk field descriptor
ini), `awcms-mini-abac-guard` (guard bersama yang juga menegakkan
`403 MODULE_DISABLED`), `awcms-mini-sensitive-data`/redaction
(`REDACTION_KEYS` yang dipakai validasi settings), `awcms-mini-audit-log`
(pola audit `tenant_module_enabled`/`_disabled`/`settings_updated`/`health_checked`).
