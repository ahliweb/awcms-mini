# Changelog

Semua perubahan penting pada AWCMS-Mini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan proyek ini menganut [Semantic Versioning](https://semver.org/lang/id/). Entri versi dihasilkan/dikonsumsi lewat [Changesets](.changeset/README.md) (`bun run changeset` → `bun run changeset:version`).

## [Unreleased]

## [0.23.5] - 2026-07-06

### Added

- **Aktivasi sistem log & manajemennya** (Issue #447, milestone M9 — issue baru berdiri sendiri, bukan bagian epic M9 5/5 yang sudah closed): tiga gap operasional yang sebelumnya tercatat eksplisit sebagai backlog (`src/modules/logging/README.md` §Belum tersedia, doc 20 §Matrix kepatuhan A.8.16) kini ditutup.
  - **Correlation ID full-propagation**: `ApiMeta.correlationId` sebelumnya hanya diwiring end-to-end ke satu endpoint demo (`GET /logs/audit`). Kini konsisten muncul pada **seluruh** respons JSON `/api/*` — diisi dari satu titik baru (`src/lib/logging/correlation-response.ts`, dipasang di `src/middleware.ts`) yang mengisi `meta.correlationId` bila handler belum mengisinya sendiri, bukan dengan mengedit puluhan file handler satu per satu. Diverifikasi live: `GET /api/v1/health`, `POST /api/v1/setup/initialize`, `POST /api/v1/auth/login`, `GET /api/v1/reports/tenant-activity` (sebelumnya tidak pernah mengisi `meta.correlationId`) kini konsisten mengisinya; endpoint yang sudah eksplisit (`GET /logs/audit`) tidak tertimpa.
  - **Retensi/purge `awcms_mini_audit_events`**: kebijakan retensi eksplisit (default **730 hari**, dikonfigurasi via `AUDIT_LOG_RETENTION_DAYS`, doc 18) + mekanisme purge (`purgeExpiredAuditEvents`, `src/modules/logging/application/audit-purge.ts`) dijalankan oleh job CLI terjadwal baru `bun run logs:audit:purge` (`scripts/audit-log-purge.ts`, pola sama seperti dispatcher Issue #436) — bukan endpoint publik. Purge berbatch (`DELETE ... LIMIT 5000` per pass per tenant), berbasis umur murni (tidak memutus FK), dan aksi purge itu sendiri direkam sebagai audit event baru (`action='purge'`) — tidak pernah purge diam-diam. Diverifikasi live terhadap Postgres nyata: 7 event lama (800 hari) terhapus, event baru tetap ada, event purge tercatat dan terbaca lewat `GET /logs/audit`.
  - **Extension point observability**: dua hook opsional default no-op, tanpa dependency baru — `setLogSink()` (`src/lib/logging/logger.ts`) dan `setAuditExportHook()` (`src/modules/logging/application/audit-log.ts`). Aplikasi turunan bisa memasang consumer log/audit (alerting, export, SIEM) tanpa mengubah kode inti; keduanya menelan error dari consumer (tidak pernah menjatuhkan aplikasi/menggagalkan transaction pemanggil). Bukan implementasi SIEM nyata — batas scope A.8.16 dari Issue #437 tidak berubah, hanya titik pemasangannya yang kini tersedia.
  - `LOG_LEVEL` diverifikasi tetap dihormati (regresi-check, bukan fitur baru) — tidak ada perubahan kode, hanya konfirmasi ulang lewat test yang sudah ada (`tests/logger.test.ts`).
  - Tidak ada migration SQL baru — tidak ada kolom/tabel/permission baru yang dibutuhkan; `bun run db:migrate` tetap 18 migration sebelum/sesudah.

## [0.23.4] - 2026-07-06

### Added

- **Security hardening berbasis standar OWASP Top 10 / ASVS / ISO 27001** (Issue #437, milestone M9 — pakai skill `awcms-mini-security-hardening`, issue terakhir epic M9): matrix kepatuhan baru di `docs/awcms-mini/20_threat_model_security_architecture.md` §"Matrix kepatuhan OWASP / ASVS / ISO 27001" memetakan kontrol yang sudah ada (ABAC default-deny, RLS FORCE, audit append-only, redaction, argon2id, HMAC sync) ke OWASP Top 10 (2021) 10/10 terpenuhi, ASVS L1/L2 8/8 area terpenuhi, dan ISO/IEC 27001:2022 Annex A 9/10 terpenuhi (1 di luar scope kode: A.8.16 monitoring/SIEM terpusat, tanggung jawab lapisan operasional aplikasi turunan) — setiap baris disertai bukti konkret (path file/fungsi/query), bukan asumsi.
- **Security response headers** (`src/lib/security/security-headers.ts`, dipasang di `src/middleware.ts` untuk setiap response): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Strict-Transport-Security` (digerbang `APP_ENV=production`). Sebelumnya tidak satupun ada — gap nyata ditemukan lewat grep repo, ditutup di PR ini.
- **Content-Security-Policy** memakai fitur bawaan Astro `security.csp` (`astro.config.mjs`), bukan nonce/hash manual. Dua pendekatan manual dicoba lebih dulu dan dibatalkan setelah verifikasi **headless-Chrome/CDP nyata** (curl tidak bisa mendeteksi pelanggaran CSP karena tidak mengeksekusi JS/CSS): nonce per-request dihapus diam-diam oleh compiler Astro dari atribut `is:inline`; hash manual untuk satu skrip `is:inline` yang diketahui ternyata melewatkan beberapa skrip/style lain yang di-inline Astro per-komponen (`ThemeToggle.astro`, `LanguageSwitcher.astro`, tombol logout) dan benar-benar memblokir fungsinya (tombol tema tidak merespons klik) saat diverifikasi di browser sungguhan. Solusi akhir: hash otomatis Astro untuk semua yang di-inline-nya + satu hash manual (`src/lib/security/theme-init-script.ts`, dijaga sinkron oleh `tests/theme-init-script.test.ts`) untuk satu-satunya skrip `is:inline` tersisa (pencegah flash tema di `AdminLayout.astro`).
- **Rate limiting login** (`src/lib/security/rate-limit.ts`, env baru `AUTH_LOGIN_RATE_LIMIT_MAX`/`AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC`, default 20/60 detik): memperluas pola lockout `AUTH_LOGIN_MAX_ATTEMPTS` yang sudah ada (per-identitas) dengan limiter sumber+tenant untuk menutup celah enumerasi lintas-identitas dari sumber yang sama. Diverifikasi live: percobaan ke-21 dari IP+tenant sama → `429 RATE_LIMITED` + header `Retry-After`; sumber IP berbeda tidak terpengaruh.
- `scripts/security-readiness.ts` diperluas dua check baru (`checkSecurityHeadersPresent` — live, hit server nyata; `checkLoginRateLimitImplemented` — murni), keduanya `warning` (defense-in-depth, bukan kontrol akses primer yang sudah `critical`).

### Fixed

- **False-positive pada gate `security:readiness` sendiri**: `checkNoHardcodedSecret` menandai `ERROR_CODE_KEYS.TOKEN_EXPIRED: "error.token_expired"` (`src/lib/i18n/error-messages.ts`, kode yang sudah ada sejak Issue #433) sebagai kemungkinan secret karena nama variabel mengandung "TOKEN" — nilainya sebenarnya kunci katalog i18n. Ditemukan dengan menjalankan gate ini sendiri terhadap kode yang sudah ada, bukan hipotetis; `bun run security:readiness` sebelumnya gagal (`GO-LIVE DIBLOKIR`) pada kode yang sudah merged. Diperbaiki dengan heuristik tambahan yang mengecualikan nilai berbentuk kunci i18n dot-namespace huruf kecil.

## [0.23.3] - 2026-07-06

### Added

- **Dispatcher object sync queue nyata** (Issue #436, milestone M9 — kerasan backend & integrasi eksternal): `dispatchObjectSyncQueue` (`src/modules/sync-storage/application/object-dispatch.ts`) menutup gap "dispatcher upload R2 nyata" yang sebelumnya jadi backlog eksplisit di `sync-storage/README.md`. Pola tiga fase claim/upload/finalize sesuai ADR-0006 (provider tidak pernah dipanggil di dalam transaction DB): CLAIM memindahkan baris `pending` jatuh tempo ke status transien baru `sending` (migrasi `018` menambah `sending` ke `CHECK` constraint, reuse kolom `next_retry_at` sebagai lease claim — tidak ada kolom baru), UPLOAD memanggil provider di luar transaction, FINALIZE menandai `sent`/`pending`+backoff/`failed` sesuai hasil. Backoff memakai ulang `evaluateObjectRetry` (`domain/object-queue.ts`) tanpa modifikasi; retry manual tetap lewat `POST /sync/object-queue/{id}/retry` yang sudah ada, tidak diubah.
- **Upload nyata via `Bun.S3Client`** (`src/modules/sync-storage/infrastructure/object-storage-uploader.ts`) — Bun-only, tanpa SDK AWS/S3 npm. Route `requires_upload=false` (R2 off/`STORAGE_DRIVER=local`) lewat no-op uploader (tanpa jaringan/I/O sama sekali, selalu sukses — provider off tidak pernah menghentikan operasional, ADR-0006); `requires_upload=true` memverifikasi checksum sha256 lokal aktual sebelum upload (pemanggil nyata pertama `verifyObjectChecksum`, sebelumnya hanya diuji langsung oleh unit test).
- **Circuit breaker generik diperluas ke provider eksternal**: `src/lib/database/circuit-breaker.ts` menambah `getProviderCircuitBreaker(providerKey)` — registry per-provider (bukan singleton tunggal seperti breaker database), dipakai uploader object storage (`"object-storage"`). Saat breaker terbuka, baris `requires_upload=true` tidak diklaim sama sekali pada pass tersebut; baris `requires_upload=false` tetap jalan karena tak pernah menyentuh provider.
- **Timeout panggilan keluar**: `src/lib/integration/timeout.ts` (`withTimeout`), env baru `OBJECT_SYNC_UPLOAD_TIMEOUT_MS` (default 10000ms).
- **CLI dispatcher terjadwal**: `bun run sync:objects:dispatch` (`scripts/object-sync-dispatch.ts`) — bukan endpoint HTTP publik, mengiterasi tenant `active` dan menguras backlog `awcms_mini_object_sync_queue` per tenant, dimaksudkan untuk cron/systemd timer/k8s CronJob.
- Idempotensi dispatcher: baris `sent`/`failed` tidak pernah diklaim ulang; kunci upload (`objectKey`) sendiri jadi dedup key alami (PUT S3/R2 ke key yang sama adalah overwrite, bukan duplikat).
- Tidak ada endpoint/event baru — dispatcher murni internal, sehingga OpenAPI/AsyncAPI baseline tidak berubah untuk issue ini.

## [0.23.2] - 2026-07-06

### Fixed

- **Audit performa aplikasi & database** (Issue #435, milestone M9): `EXPLAIN (ANALYZE, BUFFERS)` terhadap tenant yang di-seed ~200 ribu baris menemukan empat bentuk query tenant-scoped yang Seq/Bitmap-Heap-Scan seluruh tabel — listing admin object-queue (dengan/tanpa filter `status`), endpoint polling node HMAC `GET /sync/objects/status`, dan listing admin conflict tanpa filter `status` — turun dari 20-43ms ke sub-milidetik setelah migrasi `017` menambah empat index komposit `(tenant_id[, status], created_at [DESC])`.
- **Query planner memilih plan salah meski index tersedia**: listing object-queue dengan filter `status` tetap Seq Scan walau index barunya ada, karena planner salah mengestimasi baris hasil join ke `awcms_mini_sync_nodes`. Diperbaiki dengan menata ulang `fetchObjectQueueEntries` agar `LIMIT` diterapkan di dalam subquery **sebelum** join, bukan sesudah — execution time turun dari ~40ms ke <1ms.
- **N+1 write**: empat loop `INSERT` satu-per-item (assign permission ke role, assign role ke user, enqueue object sync) diganti satu `INSERT ... SELECT ... FROM unnest(...)` per request (satu round trip, bukan N).
- **N+1 read** pada `POST /sync/push`: satu `SELECT current_version` per event dalam batch diganti satu prefetch batch ke map in-memory (kunci `aggregateType:aggregateId`), diperbarui setelah tiap event diterima agar event kedua untuk aggregate yang sama dalam satu batch tetap melihat versi yang baru saja di-bump.

### Added

- **Keyset pagination**: `GET /api/v1/access/decision-logs`, `GET /api/v1/logs/audit`, dan `GET /api/v1/sync/object-queue` menerima `?cursor=` opsional (base64 `createdAt|id`, divalidasi) dan mengembalikan `nextCursor` — helper baru `src/modules/_shared/keyset-pagination.ts`.

Tidak ada `OFFSET`, `SELECT *`, atau bigint tak ter-`Number(...)` ditemukan di seluruh `src/` selama audit ini — dilaporkan apa adanya, bukan "diperbaiki" secara kosmetik.

## [0.23.1] - 2026-07-06

### Fixed

- **Audit UX/UI & aksesibilitas WCAG 2.1 AA** (Issue #434, milestone M9) atas layar admin yang sudah ada (`/login`, `/admin`, `/admin/access-users`, `/admin/sync`, `/admin/settings`, `AdminLayout.astro`) — menaikkan mutu, bukan membangun layar baru.
- **Kontras warna di bawah AA**: status pill aktif/nonaktif (teks berwarna di atas `--color-surface-2`, terukur 2.91:1/4.26:1 di tema terang dan 4.06:1 di tema gelap) dan tombol/banner primer bertulisan putih di tema gelap (`--color-primary`/`--color-danger` polos hanya 3.68:1/3.76:1 dengan teks putih) — token baru `--color-primary-strong`/`--color-success-strong`/`--color-danger-strong` (diukur ulang, semua ≥4.5:1) dipakai di tombol CTA, banner error, dan status pill (kini solid-fill, bukan teks-di-atas-tint).
- **Double-submit pada mutation form/tombol**: tak satu pun form/tombol admin (login, tambah/ubah user & role, assign/unassign role, toggle status, resolve conflict, retry queue, simpan settings) menonaktifkan dirinya selama request berjalan — klik ganda/`Enter` ganda yang cepat bisa mengirim mutation dua kali. Ditambahkan `lockElement` (`src/lib/ui/admin-form-client.ts`, modul klien bersama baru) yang menonaktifkan + `aria-busy` tombol pemicu selama request, mengembalikan state semula (termasuk saat gagal — input pengguna tetap utuh).
- **Baris empty-state hilang** pada tabel Roles di `/admin/access-users` (tabel Users sudah punya, tabel Roles tidak).
- **String hardcode lolos ekstraksi i18n #433**: `ThemeToggle.astro` masih hardcode Indonesia ("Sistem"/"Terang"/"Gelap", aria-label "Ganti tema tampilan") — kini menerima label ter-terjemahkan dari `AdminLayout.astro` seperti komponen topbar lainnya.
- **Cabang Error tak pernah ada** pada empat state pattern doc 14 (`Loading -> Error: gagal`) — kegagalan fetch data SSR (mis. DB error di `AdminLayout.astro`/keempat layar admin) sebelumnya tidak punya jalur render sama sekali (500 mentah). Ditambahkan `StateNotice.astro` (komponen bersama baru, `src/components/ui`) yang membedakan "akses ditolak" dari "gagal sementara, coba lagi" — juga menggantikan empat blok `.permission-denied` yang sebelumnya duplikat identik.

### Changed

- Empat implementasi `submitJson`/`showBanner`/`reloadAfterDelay` yang identik di `login.astro`, `admin/access-users.astro`, `admin/sync.astro`, `admin/settings.astro` diekstrak ke satu modul klien bersama (`src/lib/ui/admin-form-client.ts`).
- Ditambahkan skip-link keyboard di `AdminLayout.astro` (lompat ke konten utama, melewati topbar/sidebar), container scroll (`overflow-x: auto`) untuk semua tabel lebar (tablet), dan target sentuh ≥44px pada breakpoint tablet/mobile untuk kontrol interaktif kecil (theme toggle, tombol aksi tabel, chip hapus role).
- `AdminLayout.astro`: query nama tenant/status sync kini dibungkus `try/catch` dengan fallback aman — sebelumnya kegagalan salah satu query (dijalankan di setiap request `/admin/*`) menjatuhkan seluruh shell.
- Key `.po` baru (`common.error_*`, `common.retry`, `common.please_wait`, `admin.access_users.no_roles`, `admin.dashboard.no_module_usage`, `admin.layout.skip_to_content`, `admin.layout.theme_*`) ditambahkan paralel di `en.po`/`id.po`/`messages.pot` — keyset tetap identik di ketiga berkas.

## [0.23.0] - 2026-07-06

### Added

- **Runtime i18n** (Issue #433): katalog gettext `.po` tanpa dependency (`i18n/{messages.pot,en.po,id.po}`, parser murni di `src/lib/i18n/po-parser.ts`) untuk string UI statis — di-bundle bersama aplikasi (dibaca via `Bun.file`, bukan database). Konten data multi-bahasa (input pengguna) memakai konvensi terpisah, disimpan di database per locale aktif (`docs/awcms-mini/04_erd_data_dictionary.md` §Konten multi-bahasa; base belum punya field yang memakainya).
- Komponen **`LanguageSwitcher.astro`** di topbar admin — menampilkan nama asli + ikon bendera tiap bahasa (🇬🇧 English, 🇮🇩 Bahasa Indonesia), memilih men-set cookie `awcms_mini_locale` lalu reload penuh.
- Migrasi **`016`** mengubah default `awcms_mini_tenants.default_locale` dari `'id'` ke `'en'` untuk tenant baru (`ALTER COLUMN ... SET DEFAULT`; tenant lama tidak diubah).
- Seluruh string hardcode di halaman login, admin shell (`AdminLayout.astro`), dan layar dashboard/access-users/sync/settings diekstrak ke katalog; pesan error banner memetakan kode error (doc 05) ke pesan ter-lokalisasi lewat blob `<script type="application/json">` (katalog `.po` hanya bisa dibaca server-side).
- Formatter angka/mata uang IDR dan tanggal sadar-locale (`src/lib/i18n/format.ts`, `Intl.NumberFormat`/`DateTimeFormat`, timezone tetap `Asia/Jakarta`).

### Fixed

- **Bug ditemukan+diperbaiki saat verifikasi live**: locale tenant-fallback yang di-resolve di dalam `AdminLayout.astro` datang terlambat untuk konten halaman itu sendiri (frontmatter halaman berjalan lebih dulu daripada frontmatter layout yang membungkusnya) — shell ter-render dalam bahasa tenant yang benar, tetapi konten dashboard/access-users/sync/settings tetap Inggris. Diperbaiki dengan memindahkan resolusi locale (cookie → `default_locale` tenant → `en`) ke `src/middleware.ts`, sebelum halaman `/admin/*` mana pun dirender.

## [0.22.0] - 2026-07-06

### Added

- **Settings management**: `GET/PATCH /api/v1/settings` (nama tenant, nama legal, bahasa default, tema default, timezone, feature flags — terima subset field apa pun) dan layar admin **`/admin/settings`**, menggantikan placeholder "Pengaturan belum tersedia".
- Migrasi `015` seed dua permission baru `tenant_admin.tenant_settings.{read,update}` (tanpa perubahan schema — semua kolom sudah ada sejak migrasi 002).

### Changed

- Skrip resolusi tema no-flash (`AdminLayout.astro`) kini fallback ke `default_theme` tenant untuk browser yang belum pernah memilih tema personal di localStorage — sebelumnya hardcode `"system"`, dan kolom itu tak pernah dibaca kode mana pun sejak Issue 8.1.
- Memperbaiki dokumentasi usang (`ThemeToggle.astro`, doc 14, doc 18) yang salah menyebut `default_locale`/`default_theme` sebagai kolom `awcms_mini_tenant_settings`, padahal keduanya ada di `awcms_mini_tenants`.

### Security

- `awcms_mini_tenants` sengaja RLS-free (root tenant, `id` adalah tenant id) — endpoint Settings mengandalkan `WHERE id = <tenantId>` eksplisit di setiap `UPDATE`, bukan RLS; dibuktikan dengan test integrasi (update tenant A tidak pernah mengubah tenant B).

## [0.21.0] - 2026-07-06

### Added

- **Sync admin ops dashboard**: `GET/PATCH /api/v1/sync/nodes*` (daftar/aktifkan/nonaktifkan/ganti nama node — nonaktif langsung memblokir endpoint HMAC yang sudah menolak node tidak aktif), `GET /api/v1/sync/object-queue` (tampilan antrean objek tenant-wide, filter status) + `POST /api/v1/sync/object-queue/{id}/retry` (retry manual entri gagal, override jadwal backoff otomatis). Layar admin **`/admin/sync`** (ringkasan, tabel node/konflik/antrean-gagal) di-wire ke sidebar nav (sebelumnya stub "Segera hadir").
- Migrasi `014` seed dua permission baru `sync_storage.node_management.{read,update}` (tanpa perubahan schema).

### Changed

- `GET/POST /api/v1/sync/conflicts*` kini juga menerima cookie SSR (bukan cuma bearer) dan mencatat audit event saat resolve — gap yang sebelumnya terdokumentasi sebagai "belum ada tabel audit_events" padahal tabel itu sudah ada sejak Issue 10.1.
- Union `AccessAction` menambah `"retry"` untuk mengonsumsi permission `sync_storage.object_queue.retry` yang sudah diseed sejak Issue 6.3 tanpa endpoint pemakai — sengaja **bukan** high-risk (nudge jadwal, bukan aksi destruktif), tetap diaudit eksplisit.

## [0.20.0] - 2026-07-06

### Added

- **Access & Users management** penuh di atas fondasi Issue 2.3/2.4: `GET/POST /api/v1/users` + `PATCH /api/v1/users/{id}` (buat/ubah nama/aktifkan-nonaktifkan tenant user — nonaktif langsung memblokir login berikutnya), `GET/POST /api/v1/roles` + `PATCH/DELETE /api/v1/roles/{id}` (buat/ubah nama/ubah permission set/soft-delete role), `GET /api/v1/permissions` (katalog permission read-only), dan `DELETE /api/v1/access/assignments` (unassign — `POST` assign sudah ada sejak Issue 2.4).
- Layar admin **`/admin/access-users`**: tabel user + tabel role, form tambah user/role, editor checkbox permission per role, chip assign/unassign role, toggle aktif/nonaktif — di-wire ke sidebar nav (sebelumnya stub "Segera hadir").

### Changed

- Guard tiap endpoint baru memetakan persis ke permission granular yang sudah diseed (`user_management.{read,create,update}`, `access_control.{read,configure,assign}`) — tidak ada permission baru yang perlu di-seed.
- **Safety rail**: role sistem (`is_system=true`, mis. `owner` yang di-seed Setup Wizard) menolak perubahan `permissionIds` maupun delete dengan `409` — mencegah admin tidak sengaja mengunci semua orang keluar. Delete role juga ditolak `409` bila masih ada assignment aktif.

## [0.19.0] - 2026-07-06

### Added

- Migrasi **`013`** menegakkan RLS multi-tenant: `FORCE ROW LEVEL SECURITY` pada **31** tabel tenant-scoped (policy berlaku bahkan untuk pemilik tabel) + role aplikasi least-privilege **`awcms_mini_app`** (hanya grant DML, non-superuser, non-owner) + default GUC fail-closed (`app.current_tenant_id` = UUID nol → tak cocok tenant mana pun → 0 baris bila tabel RLS dicapai tanpa `withTenant`).
- Wiring deployment dua-peran: service satu-kali **`migrate`** (superuser, `service_completed_successfully`) + hook init **`deploy/postgres/10-create-app-role.sh`** di `docker-compose.yml` yang membuat role dari `AWCMS_MINI_APP_DB_PASSWORD`; model dua-peran didokumentasikan di `.env.example` dan `docs/awcms-mini/deployment-profiles.md`. Runner `db:migrate` diberi `stripDollarQuotedBlocks()` agar blok `DO $$ … $$` tidak salah dibaca sebagai transaction-control (+ test regresi).

### Changed

- Aplikasi kini terhubung sebagai role least-privilege **`awcms_mini_app`** (bukan pemilik/superuser) sehingga RLS benar-benar ditegakkan; migrasi tetap berjalan sebagai role privileged.
- **`security:readiness`** ditingkatkan dari cek flag ke cek **penegakan**: check "RLS enabled AND forced" kini mewajibkan `relforcerowsecurity`, dan check baru "App DB connection role does not bypass RLS" **memblokir go-live** bila peran koneksi `DATABASE_URL` superuser/BYPASSRLS. Harness integrasi di-split dua peran; test isolasi baris RLS (sebelumnya di-drop) kini aktif dan lulus.
- Perbaikan `docker-compose.yml`: volume `db` di-mount di `/var/lib/postgresql` (bukan `/var/lib/postgresql/data`) agar image `postgres:18+` mau start — celah yang lolos dari bump 18.4 (0.17.0) karena diverifikasi via `docker run`, bukan `docker compose up`.

### Security

- **Ditutup** — temuan keamanan 0.18.0: RLS multi-tenant (ADR-0003) sebelumnya inert karena aplikasi terhubung sebagai pemilik tabel + superuser dan migrasi hanya `ENABLE` (bukan `FORCE`). Kini ditegakkan penuh. Diverifikasi live terhadap `postgres:18.4`: `security:readiness` sebagai superuser → **GO-LIVE DIBLOKIR** (menangkap tepat celah ini), sebagai role least-privilege → 11/11 PASS; stack `docker-compose` penuh — app konek sebagai `awcms_mini_app`, konteks tenant bogus → **0** baris, tenant nyata → **1**, sementara superuser melewati RLS (membuktikan `FORCE` + role least-privilege yang menutup celah); 6/6 test integrasi lulus dengan handler berjalan sebagai `awcms_mini_app`.

## [0.18.0] - 2026-07-05

### Added

- Suite test **integrasi HTTP terhadap PostgreSQL nyata** (`tests/integration/`) — memanggil route handler Astro nyata, menjaga wiring endpoint yang tak bisa dijaga suite unit murni: setup singleton-lock, login argon2 + terbit sesi, rantai ABAC allow/default-deny, penolakan cross-tenant session, dan jalur write → audit → read-back. Di-gate pada `DATABASE_URL` (skip bersih tanpa DB — `bun test` lokal tetap hijau).
- Service `postgres:18.4` di CI (`quality` job) + `bun run db:migrate` sebelum `bun test`, sehingga suite integrasi berjalan (dan memblokir) pada setiap PR. Dokumentasi `tests/README.md`.

### Security

- **Temuan** (dari harness di atas, perbaikan menyusul): RLS multi-tenant (ADR-0003) tidak ditegakkan untuk DB user aplikasi karena aplikasi terhubung sebagai pemilik tabel + superuser (`rolbypassrls`), dan migrasi hanya `ENABLE` (bukan `FORCE`) ROW LEVEL SECURITY — RLS sebagai backstop inert; isolasi tenant saat ini bergantung penuh pada filter `WHERE tenant_id` layer aplikasi. Dicatat di `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` §Perawatan pasca-backlog dengan rencana perbaikan (FORCE RLS + role least-privilege + upgrade check `security:readiness`).

## [0.17.0] - 2026-07-05

### Changed

- Upgrade pin PostgreSQL 16 → **18.4** (perawatan pasca-backlog, bukan issue doc06). Mengganti pin versi forward-looking di `docker-compose.yml` (`db` service), `docs/awcms-mini/deployment-profiles.md`, dan catatan out-of-scope `security:readiness`. Tidak ada perubahan schema/kode aplikasi — seluruh 12 migration, endpoint, dan round-trip backup/restore diverifikasi live terhadap `postgres:18.4`. **Catatan operasional**: volume data named dari Postgres 16 tidak dibaca langsung oleh image 18.x — upgrade stack yang sudah jalan wajib `pg_dump`/`pg_restore` lintas major (alur `deploy/backup/*.sh`). Entri log historis (rilis 0.16.0, snapshot GitHub, entri per-issue AUDIT) sengaja tidak diubah karena mencatat versi yang benar-benar dipakai saat itu.

## [0.16.0] - 2026-07-05

### Added

- Deployment profile offline/LAN (Issue 12.2, tidak ada migration baru): `deploy/systemd/awcms-mini.service.example`, `deploy/nginx/awcms-mini.conf.example`, `deploy/pgbouncer/pgbouncer.ini.example` (kini canonical, `docs/awcms-mini/database-pooling.md` merujuk ke sini alih-alih duplikasi), `deploy/backup/backup-postgres.sh`/`restore-postgres.sh` (checksum + retention, restore aman secara default ke database uji sekali pakai, menolak menimpa database sumber).
- `docker-compose.yml` di root repo — stack LAN-first `app` (`oven/bun:1`) + `db` (`postgres:16`), plus service `pgbouncer` opsional lewat Compose profile.
- `bun run config:validate` (`scripts/validate-env.ts`) — validasi env wajib/bersyarat saat boot sesuai doc 18, tanpa pernah membocorkan nilai secret; ditambahkan sebagai tahap pertama `production:preflight`.
- `docs/awcms-mini/deployment-profiles.md` — memetakan 4 profil environment (development/staging/production/offline-LAN) ke aset deployment yang relevan.
- Ini adalah **issue terakhir** dari seluruh backlog base generik (18 issue doc06) — epic M8 dan seluruh backlog kini tuntas.

## [0.15.0] - 2026-07-05

### Added

- Workflow approval engine generik (Issue 11.1, `sql/012_awcms_mini_workflow_approval_schema.sql`): skema `awcms_mini_workflow_definitions`/`_instances`/`_tasks`/`_decisions` (4 tabel persis sesuai doc 04 — "steps" adalah daftar langkah berurutan milik definisi, bukan tabel ke-5).
- `GET /workflows/tasks` dan `POST /workflows/tasks/{id}/decisions` (bearer session, permission `workflow.approval.read`/`.approve` sesuai seed doc 17 — tidak ada endpoint create-definition/start-instance publik karena doc 17 tidak memberi permission `create`/`configure` untuk workflow; `startWorkflowInstance` internal-only).
- Self-approval guard memakai ulang mekanisme yang sudah ada di `evaluateAccess` (Issue 2.4) — bukan mekanisme baru.
- Tabel idempotency generik `awcms_mini_idempotency_keys` (doc 10/16), konsumer nyata pertamanya adalah endpoint decision workflow (`Idempotency-Key` wajib, replay aman, `409 IDEMPOTENCY_CONFLICT` untuk key sama dengan body berbeda) — dapat dipakai ulang endpoint mutation high-risk lain di masa depan.
- Keputusan workflow (approve/reject) tercatat ke audit trail generik (Issue 10.1).

## [0.14.0] - 2026-07-05

### Added

- Tooling production security readiness (Issue 10.3, tidak ada migration baru): `bun run db:pool:health` (CLI pemeriksa endpoint pool health Issue 10.2), `bun run security:readiness` (checklist go-live nyata dan terverifikasi — no hardcoded secret, `.env` tidak tracked, hashing password argon2id, login lockout, RLS, ABAC default-deny, audit log, cakupan audit soft delete/restore/purge, kebersihan secret HMAC sync, kebocoran stack trace error — dengan bagian "di luar scope base generik ini" eksplisit dan terdokumentasi untuk item domain/deployment), dan `bun run production:preflight` (mengorkestrasi migrate/spec-check/test/build/pool-health/security-readiness menjadi satu vonis go/no-go).
- Gate kritis diverifikasi live: RLS sengaja dimatikan pada satu tabel, `security:readiness` langsung melaporkan kegagalan dan memblokir go-live; diaktifkan kembali, kembali lulus penuh.

## [0.13.0] - 2026-07-05

### Added

- Database connection pooling dan backpressure (Issue 10.2, tidak ada migration baru — infrastruktur murni di `src/lib/database/`): pool config `Bun.SQL` (`max`, `prepare` dinonaktifkan saat `DATABASE_PGBOUNCER=true`, `connection.statement_timeout`), work-class concurrency gate aplikasi (`critical_transaction`/`interactive`/`reporting`/`background_sync`/`maintenance`), dan circuit breaker 3-state, keduanya dikaitkan ke `withTenant` sehingga seluruh endpoint tenant-scoped yang sudah ada otomatis terlindungi (`503 DATABASE_BUSY`) tanpa perlu mengubah setiap file endpoint.
- Endpoint sync dan reporting/audit diklasifikasi ulang ke work class `background_sync`/`reporting` sesuai tabel prioritas doc 16.
- `GET /api/v1/database/pool/health` (publik, hanya agregat) dan event `database.pool.saturated` (kontrak AsyncAPI, belum ada dispatcher live untuk event apa pun di base ini).

## [0.12.0] - 2026-07-05

### Added

- Structured logging dan audit trail (Issue 10.1, `sql/011_awcms_mini_audit_logging_schema.sql`): tabel generik `awcms_mini_audit_events` (tenant-scoped, append-only, RLS), logger JSON terstruktur (`src/lib/logging/logger.ts`, menghormati `LOG_LEVEL`), redaksi lintas-modul (`src/modules/_shared/redaction.ts`, dipakai bersama oleh logger dan audit trail), dan propagasi correlation ID via `X-Correlation-ID` di `src/middleware.ts` untuk setiap request.
- `GET /logs/audit` (bearer session, permission `logging.audit_trail.read`) untuk membaca audit trail, dengan filter `?resourceType=`/`?action=`/`?severity=`.
- Endpoint lifecycle profil tipis: `DELETE /profiles/{id}` (soft delete), `POST /profiles/{id}/restore`, `POST /profiles/{id}/purge` (hard delete, hanya setelah soft delete, ditolak `409 PURGE_BLOCKED_BY_DEPENDENTS` bila masih direferensikan tabel lain) — mendemonstrasikan audit trail end-to-end secara nyata, bukan hanya diklaim. Manajemen profil penuh (create/update/list) tetap backlog.
- Vocabulary `AccessAction` diperluas dengan `restore`/`purge` sebagai high-risk action (sesuai doc 10 §ABAC guard).

## [0.11.1] - 2026-07-05

### Fixed

- `POST /sync/push` (Issue 6.1) melakukan `JSON.stringify` sebelum bind ke kolom `payload_json` (jsonb) — Bun.SQL sudah menyerialisasi value yang di-bind ke kolom jsonb sendiri, sehingga stringify tambahan menghasilkan jsonb string scalar (teks JSON dalam tanda kutip), bukan objek jsonb nyata. Ditemukan saat membangun audit trail Issue 10.1 (kelas bug yang sama sempat muncul di kode baru dan tertangkap sebelum ship). Diperbaiki dengan bind `event.payload` langsung.

## [0.11.0] - 2026-07-05

### Added

- Management Reporting Views (Issue 9.1, `sql/010_awcms_mini_management_reporting_permission_schema.sql`): modul `reporting` baru dengan empat view agregasi baca generik (tenant activity, access/audit summary, sync health, module usage) via `GET /api/v1/reports/*` (bearer session, dijaga satu permission baru `reporting.dashboard.read`) — tidak ada tabel baru, murni agregasi atas tabel yang sudah ada.
- Dashboard admin (`/admin`, sebelumnya placeholder) kini menampilkan data nyata dari keempat view, dengan panel "Akses ditolak" bila user tidak punya permission `reporting.dashboard.read`.
- `<SyncIndicator />` di topbar (sebelumnya stub `active={false}` tetap) kini menampilkan status sync nyata (node aktif, konflik terbuka, objek gagal).

## [0.10.0] - 2026-07-05

### Added

- Admin Layout Shell (Issue 8.1): design token (`src/styles/tokens.css`) dan theming light/dark/system tanpa flash; `src/layouts/AdminLayout.astro` SSR (topbar, sidebar navigasi permission-aware, breadcrumb); komponen stub `TenantSwitcher`, `SyncIndicator` (belum ada data live — menunggu Issue 9.1), `ThemeToggle`; halaman `/login`, `/admin`, `/admin/settings`.
- Helper `resolveSsrContext` (`src/lib/auth/ssr-session.ts`), dipakai `src/middleware.ts` untuk menjaga rute `/admin/*`.
- Cookie sesi httpOnly + SameSite=Lax additive pada `POST /auth/login`/`POST /auth/logout` (body JSON tidak berubah, tetap kompatibel dengan klien bearer-token yang sudah ada) agar SSR shell dapat autentikasi tanpa mengekspos token mentah ke client-side JavaScript.

## [0.9.0] - 2026-07-05

### Added

- Antrean sinkron objek R2 (Issue 6.3, `sql/009_awcms_mini_object_sync_queue_schema.sql`): `awcms_mini_object_sync_queue` dengan enqueue upsert per `objectKey`, tracking checksum/ukuran byte, dan evaluasi retry backoff eksponensial.
- Endpoint baru `POST /sync/objects` (enqueue), `GET /sync/objects/status` — HMAC node-auth, sama seperti push/pull/status.
- `R2_ENABLED` hanya menentukan kolom `requires_upload`; tidak ada pemanggilan R2/Cloudflare SDK nyata di base ini (dispatcher upload tetap backlog, sama seperti `awcms_mini_message_outbox`). Epic M5 (Sync Storage, Issue 6.1-6.3) tuntas.

## [0.8.0] - 2026-07-05

### Added

- Sync conflict tracking dan resolution (Issue 6.2, `sql/008_awcms_mini_sync_storage_conflict_schema.sql`): `awcms_mini_sync_aggregate_versions` (versi per aggregate) dan `awcms_mini_sync_conflicts` (immutable, dua tipe generik: `missing_base_version`, `version_mismatch`).
- `POST /sync/push` menerima `baseVersion?` opsional per event; event konflik dicatat, bukan diterapkan; response menambah `conflicted`.
- Endpoint `GET /sync/conflicts`, `POST /sync/conflicts/{id}/resolve` — bearer session (bukan HMAC), di-guard permission `sync_storage.conflict_resolution.read`/`.approve` (diseed di migration ini).

### Fixed

- Kolom `bigint` (`current_version`, `sequence`, `last_pull_sequence`) dikembalikan Bun.SQL sebagai string, menyebabkan `baseVersion` yang benar salah terdeteksi sebagai konflik — ditemukan saat verifikasi live, diperbaiki dengan `Number(...)` eksplisit di `push.ts`/`pull.ts`/`status.ts` (bug laten sejak Issue 6.1).

## [0.7.0] - 2026-07-05

### Added

- Sync outbox/inbox (Issue 6.1, `sql/007_awcms_mini_sync_storage_outbox_inbox_schema.sql`): `awcms_mini_sync_nodes` (registrasi node per tenant, checkpoint cursor), `awcms_mini_sync_outbox` (event lokal siap di-pull), `awcms_mini_sync_inbox` (event diterima via push), `awcms_mini_sync_push_batches` (ledger idempotency).
- Endpoint `POST /sync/push`, `POST /sync/pull`, `GET /sync/status` — autentikasi HMAC (bukan bearer token), node auto-registrasi saat kontak pertama, menolak jika `AWCMS_MINI_SYNC_ENABLED` bukan `true`.
- Domain logic murni `computeSyncSignature`/`verifySyncSignature`/`isTimestampWithinSkew` (`src/modules/sync-storage/domain/sync-hmac.ts`) dan `validateSyncPushRequestBody`. Modul `sync-storage` didaftarkan.

### Fixed

- `GET /sync/status` tidak mengecek status node aktif (hanya cek node ada), tidak konsisten dengan `push`/`pull` — ditemukan saat verifikasi live, diperbaiki agar ketiganya konsisten menolak (403) node inactive.

## [0.6.0] - 2026-07-05

### Added

- Setup wizard awal (Issue 12.1, `sql/006_awcms_mini_setup_wizard_schema.sql`): `awcms_mini_setup_state` (singleton global, RLS-free) mengunci setup secara permanen. `GET /setup/status` dan `POST /setup/initialize` (keduanya public — belum ada identity untuk login sebelum tenant pertama dibuat).
- `initialize` adalah satu transaksi atomik: klaim lock (aman dari race condition), buat tenant, office, profile/identity/tenant_user owner, role `owner` berisi seluruh permission katalog, assignment owner→role, lalu kunci setup. Validasi input murni `validateSetupInitializeInput` (field wajib + password minimum 8 karakter).

## [0.5.0] - 2026-07-05

### Added

- RBAC dan ABAC access control (Issue 2.4, `sql/005_awcms_mini_abac_access_control_schema.sql`): `awcms_mini_permissions` (katalog global, diseed 17 entri generik untuk modul base), `awcms_mini_roles`, `awcms_mini_role_permissions`, `awcms_mini_access_assignments`, `awcms_mini_abac_policies`, dan `awcms_mini_abac_decision_logs` (append-only).
- Evaluator murni `evaluateAccess` (default deny, deny overrides allow — ADR-0004) memakai tipe `TenantContext`/`AccessRequest`/`AccessDecision` persis sesuai doc 10 §ABAC guard, dengan aturan ABAC generik (tenant isolation, self-approval deny).
- Endpoint `GET /access/modules`, `POST /access/evaluate`, `POST /access/assignments` (idempotent), `GET /access/decision-logs` — OpenAPI diperbarui.

## [0.4.0] - 2026-07-05

### Added

- Identity login and tenant user membership (Issue 2.3, `sql/004_awcms_mini_identity_login_schema.sql`): `awcms_mini_identities` (login per tenant, `password_hash` argon2id via `Bun.password`, lockout `failed_login_count`/`locked_until`), `awcms_mini_tenant_users` (status keanggotaan tenant), `awcms_mini_sessions` (token sesi opaque — hanya `token_hash` disimpan, mendukung logout nyata).
- Endpoint live pertama yang menyentuh database: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` (OpenAPI diperbarui, kode error baru `AUTH_INVALID_CREDENTIALS`).
- Infrastruktur akses data bersama: `src/lib/database/client.ts` (`Bun.SQL`), `src/lib/database/tenant-context.ts` (`assertUuid` + `withTenant`, transaction wrapper `SET LOCAL app.current_tenant_id` sesuai doc 16), `src/lib/auth/password.ts`, `src/lib/auth/session-token.ts`. Domain logic murni `evaluateLoginAttempt` di `src/modules/identity-access/domain/login-policy.ts` (anti user-enumeration, lockout otomatis). Modul `identity-access` didaftarkan.

## [0.3.0] - 2026-07-05

### Added

- Central profile schema (Issue 2.2, `sql/003_awcms_mini_central_profile_management_schema.sql`): `awcms_mini_profiles` (kanonik person/organization, soft delete), `awcms_mini_profile_identifiers` (email/phone/whatsapp/national_id/tax_id/external_code — digenerikkan dari NPWP/NIK/"customer code" doc 03 — dedup via `value_hash` unique parsial per tenant+type, `masked_value` aman), `awcms_mini_profile_channels`, `awcms_mini_profile_addresses`, `awcms_mini_profile_entity_links`, `awcms_mini_profile_merge_requests` (`CHECK source_profile_id <> target_profile_id`), dan `awcms_mini_profile_audit_logs` (append-only). Domain logic murni di `src/modules/profile-identity/domain/` (`normalizeIdentifier`, `hashIdentifier`, `maskIdentifier`, `assertMergeRequestIsValid`). Modul `profile-identity` didaftarkan (dependency: `tenant-admin`).

## [0.2.0] - 2026-07-05

### Added

- Tenant and office schema (Issue 2.1, `sql/002_awcms_mini_tenant_office_schema.sql`): `awcms_mini_tenants` (root tenant, unique `tenant_code`, lifecycle `status`), `awcms_mini_offices` (hierarki kantor per tenant, unique parsial `(tenant_id, office_code) WHERE deleted_at IS NULL`, RLS, soft delete), `awcms_mini_physical_locations` (alamat per office, RLS, soft delete), dan `awcms_mini_tenant_settings` (konfigurasi 1:1 per tenant, RLS). Modul `tenant-admin` didaftarkan di registry modul.

### Fixed

- Sprint sequencing di doc 06: Issue 12.1 (Setup Wizard) membutuhkan skema tenant/identity/RBAC yang dimiliki Issue 2.1/2.3/2.4 (Sprint 2/3), tetapi sebelumnya ditempatkan di Sprint 1 sejajar 0.1–0.3. Dipindah ke Sprint 3 (setelah 2.4). Label GitHub disesuaikan: `#376`/`#377`/`#378` (2.1/2.2/2.3) `status:blocked` → `status:ready`; `#407` (12.1) `status:ready` → `status:blocked`.

## [0.1.1] - 2026-07-05

### Fixed

- Tipe `SoftDeleteColumns.deletedAt`/`deletedBy`/`deleteReason` di `src/modules/_shared/soft-delete.ts` disamakan ke `string | null` opsional sesuai doc 10 (sebelumnya `deletedAt: Date | null` wajib).
- `.env.example` dan doc 11 §Minimal `.env.example` mewarisi nama provider spesifik-domain retail/POS (`STARSENDER_ENABLED`, `MAILKETING_ENABLED`, `AI_ANALYST_ENABLED`) dari contoh doc 18; dihapus dari file konfigurasi base dan diganti komentar generik untuk aplikasi turunan.

### Added

- Doc 13 §Repository artifact checklist ditambah subbagian "Folder standar" yang mengindeks `README.md` di `src/lib/`, `src/modules/_shared/`, `openapi/`, `asyncapi/`, `deploy/`, `fixtures/`.

## [0.1.0] - 2026-07-05

Rilis bertag pertama — Foundation (Sprint 1) sesuai `docs/awcms-mini/09_roadmap_repository_commit.md`.

### Added

- Foundation skeleton Issue 0.1: Astro 7 SSR via Bun (`@astrojs/node` adapter, mode standalone — pengecualian Bun-only tersanksi per ADR-0002), health endpoint `/api/v1/health`, module contract/registry, shared API response helper (envelope `{ success, data, meta }` / `{ success: false, error, meta }`, sesuai doc 05/10), soft-delete convention, `.env.example`, foundation SQL schema, dan folder standar (`src/`, `sql/`, `openapi/`, `asyncapi/`, `deploy/`, `fixtures/`).
- SQL migration runner Issue 0.2: `bun run db:migrate` menggunakan `Bun.SQL`, memvalidasi `sql/*.sql` terurut, menyimpan checksum SHA-256, melewati migration yang sudah diterapkan, menolak drift checksum, membungkus eksekusi dalam transaksi, dan mendokumentasikan alur operasionalnya.
- OpenAPI dan AsyncAPI baseline Issue 0.3: kontrak OpenAPI publik, kontrak AsyncAPI domain-event, skema respons/error bersama, pola soft-delete, header sync HMAC, dan validator `api:spec:check`.

### Changed

- `bun run check` kini mencakup `bun run build`, dan CI menjalankan build Astro foundation.
- `bun run check` kini mencakup `bun run api:spec:check`.
- `package.json` kini menyediakan `db:migrate` untuk migration runner PostgreSQL Bun-native.
- Snapshot dokumentasi GitHub direfresh mengikuti penyelesaian #371, #372, #373 (Epic 0).

### Fixed

- **Arsitektur SSR**: `astro.config.mjs` semula `output: "static"` dan `/api/v1/health` memakai `export const prerender = true`, sehingga endpoint ter-generate sekali saat build (bukan berjalan per-request) — bertentangan dengan RLS multi-tenant (ADR-0003) yang mensyaratkan `SET LOCAL app.current_tenant_id` per transaksi live. Diperbaiki ke `output: "server"` + adapter `@astrojs/node` (mode standalone); diverifikasi dengan menjalankan `dist/server/entry.mjs` dan memanggil `/api/v1/health` dua kali (nilai `generatedAt` berbeda tiap panggilan, membuktikan eksekusi per-request).
- **Envelope respons API**: helper `ok()`/`fail()` di `src/modules/_shared/api-response.ts`, skema `ApiSuccess`/`ApiError` di `openapi/awcms-mini-public-api.openapi.yaml`, test, dan README modul `_shared` memakai field `ok`, padahal doc 05 dan doc 10 menetapkan `success` sebagai field envelope standar. Field disamakan ke `success` di seluruh berkas tersebut.
- Pin `oven-sh/setup-bun` di CI ke commit SHA immutable untuk menyelesaikan CodeQL `actions/unpinned-tag` (#7), dan hapus referensi proyek lama terakhir dari snapshot label/milestone.
- Clean up `tsconfig.json` after foundation skeleton: remove the stale docs-only note and use the directly declared Bun type package.

## [0.0.3] - 2026-07-04

### Fixed

- **Audit menyeluruh GitHub issues vs doc 06**: membandingkan setiap field (Problem/Scope/Out of Scope/Acceptance Criteria/Security Notes/Testing/Reference Docs) tiap issue open terhadap `docs/awcms-mini/06_github_issues_detail.md`, plus label & milestone terhadap tabel rekomendasi. Ditemukan 14/18 issue drift:
  - **2 konflik konten nyata** — leftover bahasa domain dari genericization sebelumnya yang belum lengkap: `#371` (Out of Scope masih "POS, inventory, provider eksternal") dan `#377` (Acceptance Criteria masih "user/customer/tax/CRM").
  - **12 issue dengan Reference Docs basi** — dibuat sebelum `docs/adr/` dan doc 20 ada: `#371`-`#373` (Epic 0), `#376`-`#378` (Epic 2), `#391`-`#393` (Epic 6), `#403`-`#404` (Epic 10), `#406` (Epic 11).
  - Tidak ada perubahan jumlah/label/milestone (tetap 18 open/20 closed/98 label/24 milestone) — seluruh label doc 06 terverifikasi ada di GitHub, seluruh milestone issue terverifikasi cocok tabel rekomendasi.
- Snapshot `docs/awcms-mini/github/` (README, issues-open-001, issues-closed-001, labels-milestones) di-refresh; `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` dilengkapi entri yang sebelumnya belum tercatat (tsconfig.json/typecheck 0.0.1, unit testing 0.0.2).

## [0.0.2] - 2026-07-05

### Added

- **Unit testing** (`bun test` / `bun:test`) di `tests/`: `tests/docs-checks.test.mjs` (23 kasus untuk mermaid, slug/anchor, penamaan, ekstraksi/klasifikasi tautan) + `tests/check-docs-integration.test.mjs` (menjalankan pemeriksa docs penuh atas repo nyata).
- Script `test` + `test:coverage`; `bun test` dimasukkan ke `bun run check` dan gate CI (`.github/workflows/ci.yml`).

### Changed

- Refaktor `scripts/check-docs.mjs` → lib logika-murni bebas I/O (`scripts/lib/docs-checks.mjs`, ter-export) + CLI tipis dengan guard `import.meta.main` (agar dapat diimpor test tanpa efek samping).
- Doc 07 (§Testing Strategy), 10, 13, 20, `AGENTS.md`, `CONTRIBUTING.md`, `README.md` diselaraskan dengan keberadaan test + runner `bun test`.

### Fixed

- Bug fidelity `slugify`: GitHub **tidak** menggabungkan whitespace beruntun saat membuat slug heading (`"a & b"` → `"a--b"`); sebelumnya keliru meng-collapse (`\s+`), berpotensi false-negative pada validasi anchor lintas-berkas.

## [0.0.1] - 2026-07-05

Baseline paket dokumentasi, standar profesional repo publik, & tooling. Belum ada kode aplikasi; rilis bertag berikutnya direncanakan **0.1.0** (Foundation) sesuai `docs/awcms-mini/09_roadmap_repository_commit.md`.

### Added

- Paket dokumen master **01–20** (`docs/awcms-mini/`): perencanaan (01–03), kontrak (04–05), eksekusi (06–13), desain teknis implementasi (14–18), glossary (19), **threat model & arsitektur keamanan (20)**.
- **Architecture Decision Records** di `docs/adr/` (template + ADR 0001–0007: modular monolith, Bun-only, PostgreSQL+RLS, RBAC/ABAC default-deny, soft delete/immutability, offline-first/outbox, OpenAPI/AsyncAPI).
- Berkas komunitas & tata kelola repo publik: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `SUPPORT.md`, `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/` (bug/feature/documentation/config).
- Konfigurasi kualitas: `.editorconfig`, `.gitattributes`, `.prettierrc.json`, `.prettierignore`, **`tsconfig.json`** (strict, ES2024, Bun+Node types — anchor sebelum Issue 0.1, mengikuti konvensi tsconfig repo AhliWeb lain).
- `typescript`, `@types/bun`, `@types/node` sebagai devDependency; script `typecheck` (`tsc --noEmit`), digabung ke `bun run check`.
- CI kualitas dokumentasi & hygiene (`.github/workflows/ci.yml`): prettier check, pemeriksa docs Bun-native (`scripts/check-docs.mjs` — mermaid, tautan internal, penamaan), **typecheck**, gate Bun-only + no-`.env`.
- `AGENTS.md` — kontrak kerja coding agent.
- 17 **skill proyek** Claude Code di `.claude/skills/`.
- Audit standar pengembangan software (`docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`).
- Snapshot dokumentasi GitHub di `docs/awcms-mini/github/` (open/closed terpisah, batas 100 issue/file, label/milestone/security + proses refresh).
- GitHub Security baseline: `SECURITY.md` (diperluas: scope, safe harbor, target response time), `.github/dependabot.yml`, `.github/workflows/codeql.yml`.
- Diagram Mermaid di seluruh dokumen kunci.
- Versioning (SemVer) + **Changesets** + `CHANGELOG.md` + `package.json` (metadata lengkap) + `bun.lock` + `.gitignore`.

### Changed

- **Lisensi** `UNLICENSED` → **MIT**; `package.json` dilengkapi metadata (repository, bugs, homepage, keywords, engines) dan script `lint`/`format`/`check:docs`/`typecheck`/`check`.
- Backlog issue & dokumen entry (01, 06, 09, `AGENTS.md`) digenerikkan: konten domain POS/retail dikeluarkan dari base; dokumen teknis 02–19 ditandai sebagai **contoh domain ilustratif**.
- `README.md` dirapikan menjadi front door repo publik: badge, daftar isi, tautan tata kelola/keamanan/ADR, diagram arsitektur generik.

### Removed

- Berkas cruft `init` (1 byte, kosong) yang ter-track sejak sebelum standar ini.

### Fixed

- Regresi penamaan `awcms-mini_*`/`AWCMS-Mini_*` → `awcms_mini_*`/`AWCMS_MINI_*` (identifier SQL/env) yang tersisa di `.claude/skills/`.
- Referensi jumlah dokumen `01–19` → `01–20` dan penambahan doc 20 + ADR ke indeks (`AGENTS.md`, doc 13, doc 06, docs index). Issue GitHub `#405`/`#379` diselaraskan merujuk doc 20 + ADR.
- Implicit-`any` di `scripts/check-docs.mjs` (JSDoc types) agar lolos `tsc --strict` + `checkJs`.

## Peta versi rencana (base, dari doc 09)

| Versi   | Isi                                                                                 |
| ------- | ----------------------------------------------------------------------------------- |
| `0.1.0` | Foundation skeleton (SSR, module contract, migration runner, API contract baseline) |
| `0.2.0` | Tenant, identity, profile                                                           |
| `0.3.0` | RBAC/ABAC evaluator + assignment                                                    |
| `0.4.0` | Logging, pooling, security readiness                                                |
| `0.5.0` | Sync storage (outbox/inbox, conflict, R2 queue)                                     |
| `0.6.0` | UI shell, management reporting                                                      |
| `0.7.0` | Workflow approval, deployment profile                                               |
| `1.0.0` | Base production-ready                                                               |

Aplikasi turunan (mis. AWPOS) memakai peta versinya sendiri di atas base ini.

Nomor versi naik progresif per rilis, bukan hanya saat satu slot epic selesai penuh: rilis `0.2.0`-`0.4.0` berisi Issue 2.1 (tenant/office), 2.2 (central profile), dan 2.3 (identity/login) dari slot "Tenant, identity, profile" (tuntas); rilis `0.5.0` berisi Issue 2.4 (RBAC/ABAC) dari slot "RBAC/ABAC evaluator + assignment" (tuntas). Epic M2 (2.1–2.4) selesai penuh. Rilis `0.6.0` berisi Issue 12.1 (Setup Wizard) dan rilis `0.7.0` berisi Issue 6.1 (Sync Outbox/Inbox) — keduanya tidak punya slot eksplisit sendiri di tabel peta versi doc 09 (12.1 ditempatkan setelah M2, 6.1 dimulai dari slot "Sync storage" `v0.4.0` yang sebelumnya ditarget jauh lebih lambat dari realisasi progresif ini). Rilis `0.8.0` berisi Issue 6.2 (Sync Conflict Tracking/Resolution), lanjutan langsung dari slot "Sync storage" yang sama dengan 6.1. Rilis `0.9.0` berisi Issue 6.3 (R2 Object Sync Queue), menuntaskan epic M5 (Sync Storage) sepenuhnya. Rilis `0.10.0` berisi Issue 8.1 (Admin Layout Shell), issue pertama epic M7 (UI/UX & Reporting) dan issue frontend pertama di repo ini. Rilis `0.11.0` berisi Issue 9.1 (Management Reporting Views), menuntaskan epic M7 sepenuhnya. Rilis `0.11.1` adalah patch (bug fix jsonb double-encoding pada sync push, bukan issue baru). Rilis `0.12.0` berisi Issue 10.1 (Structured Logging and Audit Trail), issue pertama epic M8 (Security, Performance, Production). Rilis `0.13.0` berisi Issue 10.2 (Database Connection Pooling and Backpressure) — tidak ada migration baru, murni infrastruktur aplikasi. Rilis `0.14.0` berisi Issue 10.3 (Production Security Readiness Checklist) — juga tidak ada migration baru, murni tooling CLI yang memverifikasi kontrol yang sudah dibangun sebelumnya. Rilis `0.15.0` berisi Issue 11.1 (Workflow Approval Engine), mendarat lebih awal dari rencana semula (slot 015) karena mengikuti tepat setelah 10.3 yang tidak butuh migration. Rilis `0.16.0` berisi Issue 12.2 (Offline/LAN Deployment Profile) — tidak ada migration baru, murni aset deployment — menuntaskan epic M8 sekaligus seluruh backlog base generik (18 issue doc06).

[Unreleased]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.5...HEAD
[0.23.5]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.4...awcms-mini@0.23.5
[0.23.4]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.3...awcms-mini@0.23.4
[0.23.3]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.2...awcms-mini@0.23.3
[0.23.2]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.1...awcms-mini@0.23.2
[0.23.1]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.0...awcms-mini@0.23.1
[0.23.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.22.0...awcms-mini@0.23.0
[0.22.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.21.0...awcms-mini@0.22.0
[0.21.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.20.0...awcms-mini@0.21.0
[0.20.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.19.0...awcms-mini@0.20.0
[0.19.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.18.0...awcms-mini@0.19.0
[0.18.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.17.0...awcms-mini@0.18.0
[0.17.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.16.0...awcms-mini@0.17.0
[0.16.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.15.0...awcms-mini@0.16.0
[0.15.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.14.0...awcms-mini@0.15.0
[0.14.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.13.0...awcms-mini@0.14.0
[0.13.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.12.0...awcms-mini@0.13.0
[0.12.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.11.1...awcms-mini@0.12.0
[0.11.1]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.11.0...awcms-mini@0.11.1
[0.11.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.10.0...awcms-mini@0.11.0
[0.10.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.9.0...awcms-mini@0.10.0
[0.9.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.8.0...awcms-mini@0.9.0
[0.8.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.7.0...awcms-mini@0.8.0
[0.7.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.6.0...awcms-mini@0.7.0
[0.6.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.5.0...awcms-mini@0.6.0
[0.5.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.4.0...awcms-mini@0.5.0
[0.4.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.3.0...awcms-mini@0.4.0
[0.3.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.2.0...awcms-mini@0.3.0
[0.2.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.1.1...awcms-mini@0.2.0
[0.1.1]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.1.0...awcms-mini@0.1.1
[0.1.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.3...awcms-mini@0.1.0
[0.0.3]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.2...awcms-mini@0.0.3
[0.0.2]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.1...awcms-mini@0.0.2
[0.0.1]: https://github.com/ahliweb/awcms-mini/commits/main
