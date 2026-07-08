# Management Reporting

Implementasi Issue 9.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 9.1 — Add Management Reporting Views).

## Scope

Lima view reporting **generik** (aplikasi turunan menambah view domainnya sendiri di atas base ini):

1. **Tenant activity summary** (`GET /api/v1/reports/tenant-activity`) — nama/status/tanggal dibuat tenant, jumlah user tenant aktif (`awcms_mini_tenant_users` — tidak punya kolom `deleted_at`, jadi hanya difilter `status = 'active'`), jumlah office aktif (`awcms_mini_offices`, `status = 'active' AND deleted_at IS NULL`), dan waktu login terakhir se-tenant (`MAX(awcms_mini_identities.last_login_at)`).
2. **Access/audit summary** (`GET /api/v1/reports/access-audit`) — jumlah keputusan ABAC `allow`/`deny` dalam 30 hari terakhir plus total count all-time dari `awcms_mini_abac_decision_logs`, dan total entri `awcms_mini_profile_audit_logs` sebagai proxy generik "ada aktivitas audit lain" (base ini belum punya tabel `audit_events` umum — lihat `src/modules/sync-storage/README.md` §Belum tersedia).
3. **Sync health** (`GET /api/v1/reports/sync-health`) — jumlah sync node total/aktif dan waktu push/pull terakhir (`awcms_mini_sync_nodes`), jumlah conflict `open` (`awcms_mini_sync_conflicts`), dan jumlah objek `pending`/`failed` (`awcms_mini_object_sync_queue`). Response menambah flag turunan `hasOpenConflicts`, `hasFailedObjects`, `isHealthy` (`activeNodeCount > 0` dan tidak ada conflict terbuka/objek gagal) — lihat `domain/sync-health.ts` (`shapeSyncHealth`, pure function, unit test terpisah dari I/O).
4. **Module usage** (`GET /api/v1/reports/module-usage`) — untuk setiap modul terdaftar di `src/modules/index.ts`, satu sinyal "ada data" generik: `tenant_admin` → jumlah office, `profile_identity` → jumlah profile, `identity_access` → jumlah identity, `sync_storage` → jumlah sync node, `reporting` sendiri → jumlah baris `awcms_mini_permissions` (katalog **global**, tidak tenant-scoped — beda dari metrik lain). Modul yang tidak dikenali fungsi ini mendapat `metricLabel: "No metric defined yet"` alih-alih error, supaya generic terhadap modul baru di masa depan.
5. **Email queue health** (`GET /api/v1/reports/email-health`, Issue #499) — kesehatan antrian `email_messages`/`_delivery_attempts`: jumlah pesan per status (`queued`/`sending`/`sent`/`failed`/`cancelled`), pesan gagal terbaru, dan backlog retry (`application/email-health-report.ts`'s `fetchEmailHealthReport`). Menambah dependency modul `email` ke `dependencies` array (`module.ts`).

**Tidak ada tabel baru.** Kelima view adalah live read-aggregation atas tabel yang sudah dibuat migrasi 002-009 dan `020`-`021` (email). Migration `010_awcms_mini_management_reporting_permission_schema.sql` hanya menambah **satu** permission (`reporting.dashboard.read`) ke katalog global `awcms_mini_permissions` — cukup untuk seluruh lima view (satu fitur dashboard, sengaja tidak dipecah jadi permission per view, termasuk saat `email-health` ditambahkan di #499).

## Guard

Kelima endpoint memakai pola identik dengan `GET /api/v1/sync/conflicts` dan `POST /api/v1/access/evaluate`: bearer session (`Authorization: Bearer <token>` + header `X-AWCMS-Mini-Tenant-ID`), `resolveTenantContext` + `fetchGrantedPermissionKeys` + `evaluateAccess` (default deny) + `recordDecisionLog` (dicatat untuk setiap panggilan, allow maupun deny), digerbang oleh `{ moduleKey: "reporting", activityCode: "dashboard", action: "read" }`. Akses ditolak → `403 ACCESS_DENIED`, bukan data kosong diam-diam.

## Dashboard SSR (`/admin`)

`src/pages/admin/index.astro` (yang sebelumnya placeholder "Dashboard belum tersedia — lihat Issue 9.1" sejak Issue 8.1) sekarang SSR-fetch keempat aggregasi **langsung** lewat `withTenant` + fungsi `application/*-report.ts` di modul ini — bukan HTTP round-trip ke endpoint `/reports/*` milik aplikasi sendiri (itu redundan; endpoint tetap ada untuk kontrak API/klien lain). Jika `Astro.locals.ssrContext.permissions` tidak memuat `reporting.dashboard.read`, halaman merender panel "Akses ditolak" (bukan card kosong, bukan 500).

## SyncIndicator

`src/layouts/AdminLayout.astro` memakai `application/sync-indicator.ts` (`fetchSyncIndicatorActive`) untuk topbar `<SyncIndicator active={...} />` — ini bukan pemanggilan ulang agregasi penuh `GET /reports/sync-health`, melainkan satu query `EXISTS` ringan (layout ini render di setiap request `/admin/*`), dengan formula "sehat" yang sama: minimal satu node aktif, tidak ada conflict terbuka, tidak ada objek gagal.

## Belum tersedia

- **Tidak ada worker, materialized view, atau caching layer** — ini live aggregation setiap request. Untuk tenant dengan volume data besar (banyak sync node/decision log), latensi dashboard akan mengikuti biaya query langsung; optimasi (materialized view terjadwal, cache, dsb.) sengaja **di luar scope** issue ini dan menjadi issue tersendiri di masa depan jika beban reporting jadi masalah nyata (lihat juga rencana `019_awcms_mini_dashboard_materialized_views.sql` di `docs/awcms-mini/09_roadmap_repository_commit.md` §Migration order final rekomendasi).
- Tidak ada pagination/filter tanggal kustom pada `access-audit` — window 30 hari saat ini hardcoded (`ACCESS_AUDIT_DECISION_WINDOW_DAYS`).
- Modul domain turunan (mis. AWPOS) menambah view reporting domainnya sendiri (penjualan, stok, pajak) di modul terpisah, bukan di modul generik ini.
- `GET /api/v1/reports/email-health` (#5 di atas) belum ditambahkan ke SSR dashboard (`src/pages/admin/index.astro`) — dashboard admin baru menampilkan empat view pertama (tenant activity, access/audit, sync health, module usage); email queue health baru tersedia lewat endpoint API, belum lewat kartu di `/admin`.
