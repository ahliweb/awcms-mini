---
name: awcms-mini-reporting
description: Kerjakan bagian mana pun dari modul reporting AWCMS-Mini (Issue 9.1 lima view live, #499 email-health, diperluas #753 projections/exports epic platform-evolution #738 Wave 3). Gunakan saat menambah/mengubah endpoint di src/modules/reporting, saat modul lain mengontribusikan ProjectionDescriptor lewat reportingProjections di module.ts-nya, saat menyentuh rebuild/cursor/freshness/reconciliation, atau saat mengubah scheduled export. Merangkum kapan cursor_table AMAN vs tidak, invariant rebuild idempotent, dan gap yang sudah diketahui.
---

# AWCMS-Mini — Reporting Module

`reporting` (`src/modules/reporting`) punya **dua jalur yang hidup berdampingan
dan sengaja terpisah**:

1. **Lima view live** (Issue 9.1 + `email-health` #499) — read-aggregation
   langsung setiap request, tanpa tabel baru.
2. **Projections + scheduled exports** (Issue #753, epic `platform-evolution`
   #738 Wave 3) — read-model proyeksi berkursor, worker, freshness,
   reconciliation, export terjadwal. **Ekstensi ke modul ini, bukan modul baru.**

Jalur 2 **membungkus SEBAGIAN** dari dua endpoint jalur 1 (access-audit,
module-usage) **tanpa mengubahnya** — keduanya tetap tersedia, tidak ada yang
digantikan. Jangan asumsikan salah satu deprecated.

Baca `src/modules/reporting/README.md` untuk peta lengkap. Rasional desain
padat hidup sebagai header comment di file sumbernya — README dan skill ini
adalah PETA, bukan duplikat. Skill ini merangkum yang **tidak jelas dari
membaca satu file**: kapan strategi `cursor_table` benar-benar aman, invariant
rebuild, dan gap yang sudah diketahui & disengaja.

## Kapan pakai skill ini vs skill generik

Melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-abac-guard`, `awcms-mini-idempotency`, `awcms-mini-performance`.
Pakai skill ini untuk konteks `reporting` spesifik: mendaftarkan proyeksi,
memilih strategi update, dan aturan export.

## Jalur 1 — lima view live

Semuanya **generik** (aplikasi turunan menambah view domainnya sendiri — mis.
penjualan/stok/pajak — di modul terpisah, **bukan** di modul generik ini):

1. `GET /api/v1/reports/tenant-activity`
2. `GET /api/v1/reports/access-audit` — window 30 hari **hardcoded**
   (`ACCESS_AUDIT_DECISION_WINDOW_DAYS`), belum ada pagination/filter tanggal.
3. `GET /api/v1/reports/sync-health` — flag turunan `hasOpenConflicts`/
   `hasFailedObjects`/`isHealthy` dihitung `domain/sync-health.ts`'s
   `shapeSyncHealth` (pure function, unit-test terpisah dari I/O).
4. `GET /api/v1/reports/module-usage` — satu sinyal "ada data" generik per modul
   terdaftar. Modul yang tidak dikenali dapat
   `metricLabel: "No metric defined yet"` **alih-alih error** — sengaja, supaya
   generik terhadap modul baru. Jangan ubah jadi throw.
5. `GET /api/v1/reports/email-health` (#499).

**Tidak ada tabel baru** untuk kelima view ini — semuanya live aggregation atas
tabel migrasi 002-009 + 020-021. Migration
`010_..._management_reporting_permission_schema.sql` hanya menambah **satu**
permission (`reporting.dashboard.read`) untuk kelima view — sengaja tidak
dipecah per view, termasuk saat `email-health` ditambahkan.

**Tidak ada worker/materialized view/caching** untuk kelima endpoint ini, dan
§Projections **tidak** mengubahnya. Untuk tenant bervolume besar, latensi
dashboard mengikuti biaya query langsung; optimasi sengaja di luar scope Issue
9.1.

Dashboard SSR `/admin` (`src/pages/admin/index.astro`) mem-fetch agregasi
**langsung** lewat `withTenant` + fungsi `application/*-report.ts` — **bukan**
HTTP round-trip ke endpoint sendiri (redundan; endpoint tetap ada untuk kontrak
API/klien lain). Tanpa `reporting.dashboard.read` di
`Astro.locals.ssrContext.permissions`, halaman merender panel "Akses ditolak" —
bukan card kosong, bukan 500. `AdminLayout.astro`'s `<SyncIndicator>` memakai
`application/sync-indicator.ts` — satu query `EXISTS` ringan (layout ini render
di SETIAP request `/admin/*`), bukan agregasi penuh.

## Jalur 2 — descriptor proyeksi

`ProjectionDescriptor` di `src/modules/_shared/module-contract.ts` — bentuk yang
sama dengan `dataLifecycle`/`sodRules`: modul mengontribusikan SATU entri per
proyeksi di array `reportingProjections` di `module.ts`-nya sendiri; agregator
pusat membaca `listModules()`. Engine `reporting` **tidak pernah** menulis tabel
transaksional modul lain — ia hanya membaca tabel sumber (lewat re-scan
berkursor berbatas, atau consumer domain event) dan menulis tabel
`awcms_mini_reporting_projection_*` miliknya sendiri.

Validasi registry: `domain/projection-registry.ts`'s
`validateProjectionRegistry`, tersambung ke `bun run check` lewat
`bun run reporting:projections:registry:check`.

## CRITICAL — dua strategi update, dan kapan `cursor_table` TIDAK aman

- **`cursor_table`** — poll berbatas dan ber-urutan-kursor atas satu/lebih tabel
  sumber (`ProjectionCursorStream`), menaikkan/menurunkan counter metrik bernama
  lewat aturan row-matching. Ini satu-satunya strategi yang aman untuk tabel
  yang belum punya producer domain event — **tapi hanya BENAR untuk sumber yang
  genuinely append-only** (tanpa hard delete, tanpa soft-delete-lalu-restore):
  engine hanya pernah bisa MENAMBAH, jadi baris sumber yang kemudian hilang atau
  di-undelete akan diam-diam men-desync hitungannya.

  Karena itu yang dibungkus adalah `access_audit_summary` (ABAC decision log —
  benar-benar append-only) dan `module_activity_summary` (identity/sync node —
  tidak punya mekanisme delete sama sekali di base ini). **BUKAN**
  `sync-health`/`email-health`/hitungan office-and-profile dari `module-usage`,
  yang mutable-state atau soft-delete-with-restore dan butuh CDC/delta tracking
  level baris untuk diproyeksikan dengan aman (follow-up yang sah dan lebih
  besar, sengaja tidak dicoba).

  **Sebelum mendaftarkan proyeksi `cursor_table` baru, buktikan dulu tabel
  sumbernya append-only.** Ini pertanyaan pertama, bukan detail implementasi.

- **`domain_event`** — update steady-state DIDORONG consumer `domain_event_runtime`
  terdaftar (#742), memakai ulang mesin jobs/locks/batching/idempotency/retry/
  pause-resume modul itu alih-alih membangun yang kedua. Satu-satunya consumer
  NYATA (non-referensi) yang didaftarkan issue ini hidup di
  `domain-event-runtime/infrastructure/consumer-registry.ts`
  (`reporting.event_activity_projector`) — satu edge lintas-modul yang disengaja,
  satu arah (`domain_event_runtime -> reporting/application`). Catatan: arah
  registrasi ini adalah bagian dari akar Issue #826 (deklarasi `dependencies`
  `domain_event_runtime` tidak menyebut `reporting`) — lihat
  `awcms-mini-domain-event-runtime` §Cycle sebelum menambah consumer lagi.

Setiap proyeksi — **terlepas dari strategi steady-state-nya** — di-REBUILD lewat
mekanisme re-scan `cursor_table` berbatas yang sama persis (`rebuildSource`,
selalu ada), membaca tabel sumber otoritatif langsung (untuk
`event_activity_summary` itu berarti `awcms_mini_domain_events` sendiri, **tidak
pernah** dengan men-trigger ulang delivery).

## CRITICAL — rebuild idempotent

Referensi utama adalah header `application/projection-rebuild.ts`. Ringkasnya:

1. `triggerOrResumeRebuild` adalah **SATU-SATUNYA** tempat cursor/metrik direset
   ke nol — dilakukan di transaksi CALLER sendiri (transaksi route API), atomik
   dengan baris run baru, audit log, dan record idempotency. Partial unique index
   migration 069 (`... WHERE status = 'running'`) membuat double-reset konkuren
   **mustahil di level database**; `createRebuildRun` memakai
   `INSERT ... ON CONFLICT DO NOTHING` (**tidak pernah** exception unique-violation
   mentah) supaya race yang kalah tidak meracuni transaksi.
2. `continueRebuildPasses` **TIDAK PERNAH** mereset apa pun — hanya memajukan
   cursor run yang sudah `'running'`, satu pass berbatas = satu transaksi (select
   batch → apply delta → majukan cursor → naikkan `rows_processed`), bentuk
   crash-safe yang sama yang sudah dibuktikan engine archive/purge
   `data_lifecycle`. Crash di antara pass meninggalkan cursor/metrik/
   `rows_processed` konsisten tepat di pass TERAKHIR YANG SELESAI; resume
   melanjutkan tepat di situ — tidak pernah double-count, tidak pernah skip.
3. Selama rebuild memiliki (tenant, proyeksi), worker steady-state `cursor_table`
   **SKIP** total (no-op, bukan error) — re-scan penuh rebuild berbagi cursor yang
   SAMA, jadi dijamin sudah mencakup baris apa pun yang ditulis di window-nya.
   Consumer live `domain_event` justru **THROW** (menunda lewat jalur retry/backoff
   normal) dan, saat retry, membandingkan `occurredAt` event terhadap WATERMARK
   cursor rebuild-source stream untuk membedakan "sudah dihitung rebuild yang sejak
   itu selesai/dibatalkan/gagal" dari "belum pernah dihitung apa pun". Skip
   dengan blind-retry akan **permanen kehilangan** event (bila rebuild yang
   memblokir dibatalkan sebelum mencapainya) **atau double-count** (bila rebuild
   lanjut selesai normal) — lihat header
   `application/event-activity-projection.ts` untuk analisis penuh (temuan
   security-auditor, PR #781). Jangan "sederhanakan" jadi skip biasa.

Test adversarial (pass berbatas → crash simulasi → continuation → total tepat
benar) dan test least-privilege berbasis `provisionWorkerRole()` ada di
`tests/integration/reporting-projections.integration.test.ts`.

## Freshness — dihitung live, tidak pernah di-cache

`domain/freshness.ts`'s `computeProjectionFreshness` adalah fungsi **PURE** dari
fakta mentah yang dipersist (`last_success_at`, `consecutive_failures`) vs `now`
— **tidak pernah** enum status tersimpan. Kalau worker yang seharusnya menjaga
proyeksi berhenti SEPENUHNYA, tidak ada write lagi selamanya, tapi jalur BACA
tetap menuakan status yang dilaporkan `current` → `delayed` → `stale` murni dari
waktu berlalu. Lima state: `current`/`delayed`/`stale`/`rebuilding` (selalu
menang)/`failed` (ambang consecutive-failure, dicek SETELAH `rebuilding`).
Jangan ganti dengan kolom status — itu justru membuat worker mati terlihat sehat.

## Reconciliation

`application/projection-reconciliation.ts`'s `reconcileProjection` menghitung
control total penuh yang FRESH langsung dari kontrak `rebuildSource` yang sama
dan membandingkannya ke metrik proyeksi live. On-demand saja
(`POST /api/v1/reports/projections/{key}/reconcile`), **tanpa** `Idempotency-Key`
(nol mutasi state bisnis, hanya append baris history — postur sama dengan
endpoint dry-run `data_lifecycle`).

**Mismatch saat proyeksi sekadar `delayed` itu EXPECTED, bukan bug** — baca
freshness BERSAMAAN dengan reconcile, jangan menggantikannya.

## Scheduled exports

Minimal & self-contained — **sengaja tidak** dibangun di atas `data_exchange`
(#752, masih paralel saat issue ini rilis): mesin staged-import/large-dataset-nya
tepat untuk export business record arbitrer, bukan export snapshot metrik kecil
ini. `application/export-generation.ts` menulis snapshot CSV/JSON (satu baris per
metrik) ke `REPORTING_EXPORT_ROOT_PATH` (doc 18,
`infrastructure/local-export-adapter.ts`, ber-checksum SHA-256, CSV dinetralkan
dari formula injection) **DI LUAR transaksi DB apa pun**, lalu mencatat satu
baris manifest `awcms_mini_reporting_export_runs`.
`bun run reporting:exports:dispatch` memakai ulang fungsi generasi yang sama
persis untuk setiap config `awcms_mini_reporting_scheduled_exports` yang enabled
dan jatuh tempo.

Download (`GET /api/v1/reports/exports/runs/{id}/download`) **mengecek ulang**
RBAC/ABAC dan tenant scope **pada saat download** dan menolak artefak kedaluwarsa
dengan `410 Gone`.

### Gap yang sudah diketahui (jangan "temukan ulang", jangan asumsikan aman)

- Header `X-Checksum-Sha256` adalah nilai tersimpan manifest, **bukan** dihitung
  ulang dari byte yang benar-benar dibaca saat download — gap defense-in-depth
  minor (deteksi tampering on-disk, bukan kontrol akses primer, yang tetap
  ABAC+RLS). Dicatat, bukan diasumsikan aman (temuan security-auditor PR #781).
- **`filter` diterima/dipersist tapi BELUM diterapkan** —
  `POST /api/v1/reports/exports`'s field `filter` disimpan di config dan
  dikembalikan setiap read, tapi `generateProjectionExport` tidak pernah
  membacanya: setiap export selalu berisi snapshot metrik penuh. Alih-alih
  mengabaikan filter yang disubmit diam-diam (rasa aman palsu soal scoping),
  endpoint create **menolak** `filter` non-kosong dengan `400 NOT_IMPLEMENTED`
  sampai follow-up mendefinisikan schema-nya dan menyambungkannya ke generation
  (temuan reviewer + security-auditor, PR #781).

## Permissions — dua lapis untuk membaca proyeksi

Aditif terhadap `reporting.dashboard.read` (migration 010, tidak berubah):
`reporting.projections.{read,rebuild,analyze}`,
`reporting.exports.{read,configure,export}` (migration 070,
`domain/projection-permissions.ts`'s `REPORTING_PROJECTION_PERMISSIONS` sebagai
single source of truth).

Gate `authorizeInTransaction` kasar milik route (`reporting.projections.read`/
`.analyze`) **perlu tapi TIDAK cukup**: setiap descriptor juga mendeklarasikan
`ProjectionDescriptor.requiredPermission`-nya SENDIRI, yang tambahan di-enforce
`domain/projection-permission-filter.ts` (memfilter list, 403 untuk lookup satu
key) — pola sama dengan `filterVisibleNavigationEntries` di
`module-management/domain/navigation-registry.ts`.

Ketiga descriptor yang terdaftar hari ini kebetulan memakai `requiredPermission`
yang sama, jadi lapis kedua ini **belum bisa dibedakan** dari lapis pertama untuk
descriptor NYATA mana pun — tapi justru itulah yang menghentikan caller yang
hanya memegang permission kasar dari melihat proyeksi ber-permission lebih sempit
yang didaftarkan modul turunan di MASA DEPAN (temuan reviewer PR #781). **Jangan
hapus lapis kedua karena "redundan hari ini"** — ini persis pola "validator ada
tapi tak tersambung" terbalik: di sini validator-nya sudah tersambung, jangan
diputus.

## Guard (jalur 1)

Kelima endpoint live memakai pola identik `GET /api/v1/sync/conflicts` dan
`POST /api/v1/access/evaluate`: bearer session + header
`X-AWCMS-Mini-Tenant-ID`, `resolveTenantContext` + `fetchGrantedPermissionKeys` +
`evaluateAccess` (default deny) + `recordDecisionLog` (dicatat untuk SETIAP
panggilan, allow maupun deny), digerbang
`{ moduleKey: "reporting", activityCode: "dashboard", action: "read" }`. Akses
ditolak → `403 ACCESS_DENIED`, **bukan data kosong diam-diam**.

## API (jalur 2) & admin UI

`GET /api/v1/reports/projections[/{key}]`,
`POST .../projections/{key}/rebuild[/cancel]`,
`POST .../projections/{key}/reconcile`, `GET/POST /api/v1/reports/exports`,
`POST .../exports/{id}/disable`, `POST .../exports/trigger`,
`GET .../exports/runs`, `GET .../exports/runs/{id}/download` — lihat
`openapi/modules/reporting-projections.openapi.yaml`. **Setiap mutasi**
(`rebuild`, `rebuild/cancel`, `exports` create/disable/trigger) wajib
`Idempotency-Key`; `reconcile` dan setiap `GET` tidak.

Admin UI: `/admin/reporting/projections` — tabel status freshness dengan aksi
rebuild/cancel/reconcile/export, manajemen scheduled export, riwayat export run
dengan link download. Setiap mutasi lewat endpoint `/api/v1/reports/*` nyata via
`submitJson`, tanpa shortcut privileged.

## Pitfall umum

1. Jangan daftarkan proyeksi `cursor_table` atas tabel sumber yang bisa
   hard-delete atau soft-delete-lalu-restore.
2. Jangan reset cursor/metrik di luar `triggerOrResumeRebuild`.
3. Jangan ganti freshness dengan kolom status tersimpan.
4. Jangan sederhanakan penanganan rebuild-in-progress consumer `domain_event`
   jadi skip biasa.
5. Jangan hapus lapis kedua `ProjectionDescriptor.requiredPermission`.
6. Jangan bikin `module-usage` melempar untuk modul tak dikenal.
7. Jangan tulis export di dalam transaksi DB.
8. Jangan tambah tabel/worker/cache ke kelima view live — itu di luar scope 9.1.

## Verifikasi

`tests/unit/reporting-projection-{freshness,permission-filter,registry}.test.ts`,
`tests/reporting.test.ts`, dan
`tests/integration/reporting-projections.integration.test.ts`. Plus gate CLI:
`bun run reporting:projections:registry:check`. Jalankan `bun test` dengan
`DATABASE_URL` — tanpa itu seluruh test integration dilewati diam-diam.
