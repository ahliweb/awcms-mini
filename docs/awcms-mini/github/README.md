# Dokumentasi GitHub AWCMS-Mini

Dokumen ini mencatat snapshot live repository GitHub `ahliweb/awcms-mini`. Folder ini adalah **snapshot state GitHub**, bukan backlog rencana; backlog rencana tetap berada di `docs/awcms-mini/06_github_issues_detail.md`. Metadata label/milestone di folder ini adalah salinan faktual dari GitHub saat refresh; bila ada deskripsi lama yang berbeda dari arsitektur Bun + Astro 7 + PostgreSQL, ikuti `README.md`, `AGENTS.md`, dan dokumen utama `docs/awcms-mini/`.

| Metadata     | Nilai                           |
| ------------ | ------------------------------- |
| Repository   | `ahliweb/awcms-mini`            |
| Snapshot     | 2026-07-06T14:02:04.204Z        |
| Total issue  | 55                              |
| Open issue   | 4                               |
| Closed issue | 51                              |
| Labels       | 98 (25 doc 06 + 73 peninggalan) |
| Milestones   | 25 (6 doc 06 + 19 peninggalan)  |

## File snapshot

| State           | File                                         |                                         Jumlah issue |
| --------------- | -------------------------------------------- | ---------------------------------------------------: |
| OPEN            | [issues-open-001.md](issues-open-001.md)     |                                                    4 |
| CLOSED          | [issues-closed-001.md](issues-closed-001.md) |                                                   51 |
| LABEL/MILESTONE | [labels-milestones.md](labels-milestones.md) |                             98 labels, 25 milestones |
| SECURITY        | [security.md](security.md)                   | Security policy, Dependabot, secret scanning, CodeQL |

## Aturan pencatatan

1. Snapshot issue GitHub disimpan di folder ini, bukan menggantikan `06_github_issues_detail.md` yang tetap menjadi template issue rencana.
2. File issue dipisah berdasarkan state: `issues-open-NNN.md` dan `issues-closed-NNN.md`.
3. Satu file issue tidak boleh berisi lebih dari 100 issue.
4. Jangan menyalin token, secret, dump database, atau data customer asli ke issue maupun snapshot docs.
5. Saat issue, label, atau milestone berubah di GitHub, refresh snapshot ini agar docs tetap sinkron dengan state GitHub terbaru.

## Proses refresh snapshot

Cara yang direkomendasikan (Issue #464, skill `awcms-mini-github-snapshot`):

```bash
gh auth status
bun run github:snapshot:refresh
bun run format
bun run check:docs
```

`scripts/github-snapshot-refresh.ts` meregenerasi tabel metadata (snapshot
timestamp, jumlah issue/label/milestone, latest CodeQL run, alert count)
di kelima file folder ini, plus dua tabel daftar issue yang tumbuh (open
issues; closed issues pasca-doc06) lewat marker
`<!-- github-snapshot:NAME:start/end -->`. Yang **tidak** disentuh script
(tetap manual): narasi hand-written ("### ... completed" di `README.md`),
tabel historis 38-issue doc06 asli di `issues-closed-001.md`, tabel
klasifikasi detail label/milestone di `labels-milestones.md`, dan tabel
"Ringkasan state saat snapshot" di bawah — tinjau dan perbarui bagian ini
manual setelah menjalankan script bila ada issue/label baru yang butuh
konteks naratif.

Data mentah yang dipakai script (untuk debugging/verifikasi manual bila
perlu):

```bash
gh issue list --repo ahliweb/awcms-mini --state all --limit 1000 --json number,title,state,createdAt,updatedAt,closedAt,author,labels,assignees,milestone,url,body,comments
gh label list --repo ahliweb/awcms-mini --limit 500 --json name,description,color
gh api 'repos/ahliweb/awcms-mini/milestones?state=all&per_page=100'
```

Update juga metadata di `docs/awcms-mini/README.md`, `06_github_issues_detail.md`, `09_roadmap_repository_commit.md`, `13_final_master_index_traceability.md`, dan `CHANGELOG.md` bila struktur dokumentasi berubah (di luar cakupan script).

## Ringkasan state saat snapshot

| State  | Jumlah | Catatan                                                                                                                                                                                                                                                                                                    |
| ------ | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN   |      4 | #462-#465 — issue docs/tooling/planning pasca-analisis lanjutan (panduan deploy Coolify, contoh modul domain minimal, tooling snapshot, rencana pilot aplikasi turunan). #461 (refresh snapshot) sudah `completed` — lihat CLOSED. Bukan bagian backlog doc06 (18 issue itu sudah `completed` seluruhnya). |
| CLOSED |     51 | 20 issue domain ditutup `not planned`; 18 issue backlog doc06 (#371-#373, #376-#379, #391-#393, #398, #401, #403-#408) ditutup `completed`; epic M9 (#433-#438, #447, 7 issue) dan 6 issue pasca-analisis lanjutan (#450-#454, #461) ditutup `completed` di luar backlog doc06 — lihat bagian di bawah.    |

### Issue pasca-analisis #450-#454 completed (2026-07-06)

Lima issue perbaikan/perluasan di luar backlog doc06, dibuat setelah analisis repo pasca-M9 dan semuanya ditutup `completed` pada hari yang sama:

- **[#450](https://github.com/ahliweb/awcms-mini/issues/450)** — sinkronisasi `AGENTS.md`/`docs/awcms-mini/README.md`/`docs/ARCHITECTURE.md`/`src/lib/README.md` agar tidak lagi terbaca seolah base masih di tengah foundation ("Kerjakan Issue 0.1", "modul belum diimplementasikan"); arsip bootstrap di doc 12/13 diberi banner status, bukan dihapus.
- **[#451](https://github.com/ahliweb/awcms-mini/issues/451)** — ADR-0008: tiga skema SemVer independen (rilis package, kontrak OpenAPI/AsyncAPI, module descriptor). Kontrak dinaikkan `0.1.0` → `1.0.0`; ketujuh module descriptor `experimental` → `active`. `api:spec:check` kini memvalidasi `info.version` berbentuk SemVer.
- **[#452](https://github.com/ahliweb/awcms-mini/issues/452)** — CodeQL matrix diperluas dari `actions` saja menjadi `actions` + `javascript-typescript` (`build-mode: none`, Bun-only). Dua temuan nyata dari scan pertama (`js/unused-local-variable`, `js/file-system-race`) diperbaiki dan dikonfirmasi `state: fixed` — lihat `security.md`.
- **[#453](https://github.com/ahliweb/awcms-mini/issues/453)** — `docs/awcms-mini/derived-application-guide.md` baru: tabel base-reusable vs domain-specific, alur 9 langkah berbasis skill nyata, 5 contoh aplikasi turunan ilustratif, checklist keamanan.
- **[#454](https://github.com/ahliweb/awcms-mini/issues/454)** — `Dockerfile.production` opsional (registry-based deployment, berdampingan dengan `docker-compose.yml` LAN-first) — diverifikasi nyata: `docker build` + `docker run` terhadap Postgres nyata, non-root user dikonfirmasi, `GET /api/v1/health` → 200, `POST /setup/initialize` menulis baris nyata.

### Epic M9 — Peningkatan & Hardening pasca-backlog tuntas (2026-07-06)

Milestone M9 (5 anak issue peningkatan pasca-backlog v0.22.0, epic [#438](https://github.com/ahliweb/awcms-mini/issues/438)) dan satu issue lanjutan berdiri sendiri di milestone yang sama, seluruhnya `completed`:

- **[#433](https://github.com/ahliweb/awcms-mini/issues/433)** — runtime i18n (katalog `.po` gettext, default `en`, min en+id).
- **[#434](https://github.com/ahliweb/awcms-mini/issues/434)** — audit UX/UI & aksesibilitas WCAG 2.1 AA atas layar admin yang sudah ada.
- **[#435](https://github.com/ahliweb/awcms-mini/issues/435)** — audit performa (index RLS-aware, N+1 dihilangkan, keyset pagination — diukur `EXPLAIN ANALYZE` sebelum/sesudah).
- **[#436](https://github.com/ahliweb/awcms-mini/issues/436)** — dispatcher object sync queue nyata + kerasan integrasi eksternal (circuit breaker per-provider, timeout).
- **[#437](https://github.com/ahliweb/awcms-mini/issues/437)** — security hardening berbasis standar (matrix kepatuhan OWASP Top 10/ASVS/ISO 27001).
- **[#438](https://github.com/ahliweb/awcms-mini/issues/438)** — epic tracking, ditutup setelah 5/5 anak issue selesai.
- **[#447](https://github.com/ahliweb/awcms-mini/issues/447)** — aktivasi sistem log & manajemennya (correlation ID otomatis lintas endpoint, retensi/purge audit log terjadwal, extension point observability) — issue berdiri sendiri, bukan bagian 5 anak epic #438.

Detail lengkap tiap issue: `CHANGELOG.md` (versi 0.23.0-0.23.5) dan `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` §Perawatan pasca-backlog.

### Offline/LAN deployment profile 12.2 completed — seluruh backlog base generik tuntas (2026-07-05)

Issue [#408](https://github.com/ahliweb/awcms-mini/issues/408) ditutup `completed` — **issue terakhir dari 18 issue backlog base generik doc06**; epic M8 dan seluruh backlog kini tuntas. Tidak ada migration baru, deliverable-nya murni aset deployment: `deploy/systemd/awcms-mini.service.example`, `deploy/nginx/awcms-mini.conf.example`, `deploy/pgbouncer/pgbouncer.ini.example` (kini canonical — `docs/awcms-mini/database-pooling.md` merujuk ke sini alih-alih duplikasi), `deploy/backup/backup-postgres.sh`/`restore-postgres.sh` (checksum + retention, restore aman secara default ke database uji sekali pakai, menolak menimpa database sumber). `docker-compose.yml` di root: stack LAN-first `app` (`oven/bun:1`) + `db` (`postgres:16`), plus service `pgbouncer` opsional lewat Compose profile. `bun run config:validate` (validasi env wajib/bersyarat sesuai doc 18, tanpa membocorkan nilai secret) ditambahkan sebagai tahap pertama `production:preflight`. `docs/awcms-mini/deployment-profiles.md` baru memetakan 4 profil environment ke aset deployment yang relevan. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan, **termasuk `docker-compose.yml` benar-benar dinyalakan terhadap Docker nyata** (diverifikasi ulang independen): container `app`+`db` boot bersih, `GET /api/v1/health` → 200; tenant nyata dibuat; backup asli (`pg_dump` + checksum SHA-256) dan restore asli (ke database uji terpisah) dijalankan penuh, jumlah baris cocok persis antara sumber dan hasil restore; percobaan restore ke database sumber ditolak bersih. **Bug ditemukan+diperbaiki**: service `app` sempat jalan sebagai root, menulis file root-owned ke repo yang di-mount — diperbaiki dengan `user: "${APP_UID}:${APP_GID}"` eksplisit.

### Workflow approval engine 11.1 completed (2026-07-05)

Issue [#406](https://github.com/ahliweb/awcms-mini/issues/406) ditutup `completed`. Migrasi `sql/012_awcms_mini_workflow_approval_schema.sql` menambahkan 4 tabel generik persis sesuai doc 04 §Workflow (`awcms_mini_workflow_definitions`/`_instances`/`_tasks`/`_decisions` — "steps" adalah daftar langkah jsonb milik definisi, bukan tabel ke-5) plus tabel idempotency generik `awcms_mini_idempotency_keys` (doc 10/16, konsumer nyata pertamanya). Seed 2 permission persis sesuai doc 17 (`workflow.approval.read`/`.approve` — tidak ada `create`/`configure` karena doc 17 memang tidak menyediakannya). Karena base generik ini belum punya aksi bisnis konkret yang butuh approval, tidak ada endpoint publik "create definition"/"start instance" — `startWorkflowInstance` internal-only; permukaan publik adalah persis "decision API": `GET /workflows/tasks` dan `POST /workflows/tasks/{id}/decisions` (wajib `Idempotency-Key`). Self-approval guard **tidak dibangun baru** — memakai ulang mekanisme yang sudah ada di `evaluateAccess` sejak Issue 2.4. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang independen, termasuk menemukan+memperbaiki bug di skrip verifikasi sendiri — bukan kode produk — yang salah men-stringify jsonb sebelum bind): pemohon mencoba memutuskan task miliknya sendiri → `403 "Self-approval is not allowed"` (bukti konkret); approver lain menyetujui langkah 1 dari 2 → instance tetap pending, task langkah 2 dibuat; approve langkah 2 (terakhir) → instance `approved`; instance terpisah ditolak di langkah 1 → langsung `rejected`, tidak ada task tambahan; keputusan tercatat di audit trail; user tanpa role → `403`. Verifikasi HTTP/CLI saja (backend/API, tidak relevan untuk browser). **Tidak ada bug baru ditemukan pada kode yang dikirim** (satu bug ditemukan+diperbaiki sebelum ship: idempotency response sempat double-encoded sebelum bind jsonb). Migration mendarat lebih awal dari rencana semula (slot 015) karena mengikuti tepat setelah 10.3 yang tidak butuh migration.

### Production security readiness checklist 10.3 completed (2026-07-05)

Issue [#405](https://github.com/ahliweb/awcms-mini/issues/405) ditutup `completed` — tidak ada migration baru, deliverable-nya tiga script CLI yang memverifikasi kontrol yang sudah ada, bukan skema baru. `bun run db:pool:health` (wrapper CLI atas `GET /database/pool/health` Issue 10.2); `bun run security:readiness` (10 pemeriksaan bernama, masing-masing didukung sinyal nyata — query DB langsung `pg_class.relrowsecurity` untuk RLS, pemanggilan fungsi domain sungguhan `evaluateAccess`/`evaluateLoginAttempt`/`hashPassword`, grep file tracked-git — bukan hardcode; bagian eksplisit "di luar scope base generik ini" untuk item domain [tax/CRM/AI] dan deployment [Postgres publik, least-privilege, backup/restore] yang ditunda ke Issue 12.2); `bun run production:preflight` (mengorkestrasi migrate/spec-check/test/build/pool-health/security-readiness menjadi satu vonis go/no-go). Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang independen): kesepuluh pemeriksaan lulus terhadap DB nyata. **Bukti gate kritis**: RLS sengaja dimatikan pada satu tabel via `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` → `security:readiness` langsung melaporkan gagal dan `GO-LIVE DIBLOKIR` (exit 1); diaktifkan kembali → lulus penuh (exit 0) — membuktikan gate benar-benar memblokir, bukan sekadar mencetak "pass". `production:preflight` diverifikasi baik dengan maupun tanpa server berjalan (tahap `db:pool:health` di-skip dengan jelas bila server tidak ada, bukan gagal). **Tidak ada bug baru ditemukan**.

### Database connection pooling and backpressure 10.2 completed (2026-07-05)

Issue [#404](https://github.com/ahliweb/awcms-mini/issues/404) ditutup `completed` — tidak ada migration baru, murni infrastruktur aplikasi di `src/lib/database/`. Pool config `Bun.SQL` (`max`, `prepare` dinonaktifkan saat `DATABASE_PGBOUNCER=true`, `connection.statement_timeout`); work-class concurrency gate aplikasi (`critical_transaction`/`interactive`/`reporting`/`background_sync`/`maintenance`, sesuai tabel prioritas doc 16); circuit breaker 3-state murni. Keduanya dikaitkan ke satu titik integrasi berleverage tinggi: `withTenant` (dipanggil semua endpoint yang sudah ada), sehingga seluruh endpoint tenant-scoped otomatis terlindungi `503 DATABASE_BUSY` tanpa mengubah setiap file endpoint satu-satu; 7 endpoint sync direklasifikasi ke `background_sync`, 4 endpoint `/reports/*` + `/logs/audit` ke `reporting`. Endpoint baru `GET /database/pool/health` (publik, hanya agregat) dan event kontrak AsyncAPI `database.pool.saturated` (belum ada dispatcher live). Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang independen): health baseline `healthy` semua work class `active:0`; 3000 request `POST /sync/push` konkuren membuat antrean `background_sync` (max 4) benar-benar bertambah sampai kedalaman 251 (dikonfirmasi via polling health bersamaan), lalu mengering ke 0 — membuktikan gate nyata membatasi konkurensi. Jalur 503/circuit breaker dibuktikan deterministik lewat 12 unit test baru; reproduksi live jalur 503 sensitif kecepatan lingkungan sandbox, tidak selalu bisa dipicu HTTP dalam waktu singkat. Verifikasi HTML/HTTP saja (tidak ada browser sungguhan). **Tidak ada bug baru ditemukan**.

### Structured logging and audit trail 10.1 completed (2026-07-05)

Issue [#403](https://github.com/ahliweb/awcms-mini/issues/403) ditutup `completed` — issue pertama epic M8 (Security, Performance, Production). Migrasi `sql/011_awcms_mini_audit_logging_schema.sql` menambahkan tabel generik `awcms_mini_audit_events` (tenant-scoped, append-only, RLS — bentuk persis sesuai doc 10 §Audit helper dan skill `awcms-mini-audit-log`) plus 2 permission baru: `logging.audit_trail.read` dan `profile_identity.profile_management.purge` (`.delete`/`.restore` sudah diseed sejak migration `005`). Infrastruktur baru: redaksi lintas-modul (`src/modules/_shared/redaction.ts`), logger JSON terstruktur (`src/lib/logging/logger.ts`, menghormati `LOG_LEVEL`), correlation ID di `src/middleware.ts` (additive terhadap guard `/admin/*` dari Issue 8.1), dan `AccessAction` diperluas dengan `restore`/`purge` sebagai high-risk action. Endpoint baru: `GET /logs/audit` (bearer session, permission tunggal) dan lifecycle profil tipis `DELETE /profiles/{id}`, `POST /profiles/{id}/restore`, `POST /profiles/{id}/purge` — mendemonstrasikan audit trail secara nyata (CRUD profil penuh tetap backlog). Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang independen): soft delete/restore profil owner menghasilkan audit event terpisah dengan attributes aman; purge tanpa soft delete dulu ditolak `400`; purge profil yang masih direferensikan identity ditolak `409 PURGE_BLOCKED_BY_DEPENDENTS` (FK violation ditangkap bersih via `tx.savepoint()`, audit event "blocked" tetap tersimpan meski DELETE-nya di-rollback); profil tanpa dependent berhasil di-purge, baris benar-benar hilang; user tanpa role ditolak `403` di keempat endpoint baru. Verifikasi HTML/HTTP saja (tidak ada browser sungguhan di sandbox). **Bug ditemukan+diperbaiki** (2, sebelum ship): audit attributes sempat di-double-encode via `JSON.stringify` sebelum bind ke kolom jsonb; pengecekan FK violation sempat memeriksa field error yang salah. **Bug tambahan ditemukan di kode Issue 6.1 yang sudah shipped** (kelas bug jsonb double-encoding yang identik di `POST /sync/push`) — diperbaiki terpisah sebagai patch `0.11.1` sebelum PR issue ini merge.

### Management reporting views 9.1 completed + epic M7 tuntas (2026-07-05)

Issue [#401](https://github.com/ahliweb/awcms-mini/issues/401) ditutup `completed` setelah migrasi `sql/010_awcms_mini_management_reporting_permission_schema.sql` menyisipkan satu permission baru `reporting.dashboard.read` (tidak ada tabel baru — keempat view adalah agregasi baca murni atas tabel yang sudah ada). Modul `reporting` baru: `GET /reports/tenant-activity`, `GET /reports/access-audit`, `GET /reports/sync-health`, `GET /reports/module-usage` (bearer session, guard permission tunggal, pola sama seperti `POST /access/evaluate`). Mengisi dua hal yang sengaja ditunda Issue 8.1: `/admin` (sebelumnya placeholder) kini SSR-render kartu data nyata dengan panel "Akses ditolak" bila tidak berizin, dan `<SyncIndicator>` topbar (sebelumnya stub tetap) kini mencerminkan status sync nyata. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang independen): keempat endpoint mengembalikan JSON number asli; menambah office kedua mengubah `activeOfficeCount` 1→2 baik di endpoint maupun dashboard; **kasus negatif**: user tanpa role sama sekali ditolak `403` dan `/admin` menampilkan panel akses ditolak, bukan crash. Verifikasi HTML/HTTP saja (tidak ada browser sungguhan di sandbox). **Tidak ada bug baru ditemukan**. Epic M7 (UI/UX & Reporting, Issue 8.1-9.1) tuntas sepenuhnya — karena M5 dan M7 kini sama-sama tuntas, label `#403`/`#404`/`#405`/`#406`/`#408` (M8) `status:blocked` → `status:ready` (doc 06 §Ketergantungan milestone: M8 butuh M5 **dan** M7).

### Admin layout shell 8.1 completed (2026-07-05)

Issue [#398](https://github.com/ahliweb/awcms-mini/issues/398) ditutup `completed` — issue frontend pertama di repo ini (0.1-6.3 seluruhnya backend-only). Menambahkan design token/theming (`src/styles/tokens.css`, light/dark/system tanpa flash), `src/layouts/AdminLayout.astro` SSR (topbar dengan nama tenant nyata, sidebar navigasi difilter permission efektif, breadcrumb), komponen stub `TenantSwitcher`/`SyncIndicator` (menunggu data live Issue 9.1)/`ThemeToggle`, halaman `/login`, `/admin`, `/admin/settings`, helper `resolveSsrContext` (menggunakan ulang `resolveTenantContext`/`fetchGrantedPermissionKeys` dari modul `identity-access`), dan cookie sesi httpOnly + SameSite=Lax **additive** pada `POST /auth/login`/`POST /auth/logout` (body JSON tidak berubah). Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang independen): redirect ke `/login` tanpa sesi, cookie ter-set saat login, akses `/admin` dengan cookie menampilkan nama tenant + nav sesuai permission owner, logout menghapus cookie dan sesi kembali ditolak. Verifikasi HTML/HTTP saja (tidak ada browser sungguhan di sandbox). **Bug ditemukan+diperbaiki**: `Astro.redirect()` di komponen layout bersarang melempar `ResponseSentError` (SSR streaming sudah mulai) — dipindahkan ke `src/middleware.ts`. Issue pertama epic M7 (UI/UX & Reporting) tuntas.

### R2 object sync queue 6.3 completed (2026-07-05)

Issue [#393](https://github.com/ahliweb/awcms-mini/issues/393) ditutup `completed` setelah migrasi `sql/009_awcms_mini_object_sync_queue_schema.sql` menambahkan `awcms_mini_object_sync_queue` (antrean objek lokal menunggu sinkron/upload, unique `(tenant_id, node_id, object_key)` — re-enqueue `objectKey` yang sama adalah **upsert**, bukan duplikat) dan 2 permission baru `sync_storage.object_queue.read`/`.retry`. Domain logic murni baru: `verifyObjectChecksum`, `evaluateObjectRetry` (backoff eksponensial, maks 5 retry). Endpoint baru (HMAC node auth, sama seperti push/pull/status): `POST /sync/objects` (enqueue, `requires_upload` diisi dari env `R2_ENABLED` — **tidak ada pemanggilan R2/Cloudflare SDK nyata**, sama seperti `awcms_mini_message_outbox` yang juga belum punya dispatcher live) dan `GET /sync/objects/status`. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan (diverifikasi ulang secara independen, bukan hanya dipercaya dari implementasi): enqueue baru sebagai `pending`, re-enqueue `objectKey` sama mengonfirmasi upsert (tetap 1 baris), status endpoint mengembalikan `retryCount`/`byteSize` sebagai JSON number asli (pelajaran bigint dari Issue 6.2 diterapkan preventif). **Tidak ada bug baru ditemukan**. Epic M5 (Sync Storage, Issue 6.1-6.3) tuntas sepenuhnya.

### Sync conflict tracking/resolution 6.2 completed (2026-07-05)

Issue [#392](https://github.com/ahliweb/awcms-mini/issues/392) ditutup `completed` setelah migrasi `sql/008_awcms_mini_sync_storage_conflict_schema.sql` menambahkan `awcms_mini_sync_aggregate_versions` (versi per aggregate untuk optimistic concurrency generik) dan `awcms_mini_sync_conflicts` (immutable, dua tipe konflik generik: `missing_base_version`, `version_mismatch`), plus kolom `conflicted_count` di `awcms_mini_sync_push_batches` dan 2 permission baru `sync_storage.conflict_resolution.read`/`.approve`. `POST /sync/push` menerima `baseVersion?` opsional per event dan mencatat event konflik alih-alih menerapkannya. Endpoint baru `GET /sync/conflicts` dan `POST /sync/conflicts/{id}/resolve` — sengaja diautentikasi via **bearer session** (bukan HMAC seperti push/pull/status), karena resolusi konflik adalah keputusan manual manusia sesuai ADR-0006. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan: push tanpa versi awal diterima, push tanpa `baseVersion` konflik (`missing_base_version`), push dengan `baseVersion` basi konflik (`version_mismatch`), push dengan `baseVersion` benar diterima, resolve conflict sukses, resolve ulang conflict yang sama ditolak 409. **Bug ditemukan+diperbaiki**: kolom `bigint` Postgres (`current_version`, `sequence`, `last_pull_sequence`) dikembalikan Bun.SQL sebagai string di runtime meski di-type-assert `as number`, menyebabkan push valid salah terdeteksi sebagai `version_mismatch` — diperbaiki dengan `Number(...)` eksplisit di `push.ts`/`pull.ts`/`status.ts` (bug laten sejak Issue 6.1, sekaligus memperbaiki pelanggaran kontrak OpenAPI `checkpoint: integer`).

### Sync outbox/inbox 6.1 completed (2026-07-05)

Issue [#391](https://github.com/ahliweb/awcms-mini/issues/391) ditutup `completed` setelah migrasi `sql/007_awcms_mini_sync_storage_outbox_inbox_schema.sql` menambahkan `awcms_mini_sync_nodes`, `awcms_mini_sync_outbox`, `awcms_mini_sync_inbox`, dan `awcms_mini_sync_push_batches` (ledger idempotency). Endpoint baru `POST /sync/push`, `POST /sync/pull`, `GET /sync/status` — autentikasi HMAC (bukan bearer token), node auto-registrasi saat kontak pertama, menolak jika `AWCMS_MINI_SYNC_ENABLED` bukan `true`. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan: signature salah ditolak, push idempotent per batchId, pull maju checkpoint dengan benar, timestamp kedaluwarsa ditolak. **Bug ditemukan+diperbaiki**: `GET /sync/status` tidak mengecek status node aktif (beda dari push/pull) — diperbaiki agar konsisten menolak node inactive.

### Setup wizard 12.1 completed + koreksi sprint (2) (2026-07-05)

Issue [#407](https://github.com/ahliweb/awcms-mini/issues/407) ditutup `completed` setelah migrasi `sql/006_awcms_mini_setup_wizard_schema.sql` menambahkan `awcms_mini_setup_state` (singleton global, RLS-free) yang mengunci setup secara permanen. Endpoint baru `GET /setup/status` dan `POST /setup/initialize` (keduanya public — belum ada identity untuk login sebelum tenant pertama dibuat); `initialize` satu transaksi atomik: klaim lock aman dari race condition, buat tenant + office + owner (profile/identity/tenant_user) + role `owner` berisi seluruh permission katalog + assignment, lalu kunci setup. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan: status awal `locked:false`, `initialize` valid berhasil, status sesudahnya `locked:true`, **`initialize` kedua ditolak 403** (seed idempotent, tidak bisa dijalankan ulang), owner baru berhasil login dan punya seluruh 17 permission.

Saat menutup issue ini ditemukan **koreksi urutan sprint (2)**: rekomendasi Sprint 4/5 di doc 06 sebelumnya tertukar — Issue 10.1-10.3/11.1/12.2 (milestone M8) sebenarnya butuh M5 (Sync, 6.1-6.3) **dan** M7 (UI/Reporting, 8.1/9.1) selesai dulu, bukan sebaliknya. Label `#391`/`#392`/`#393`/`#398`/`#401` (M5+M7, hanya butuh M2 yang sudah tuntas) `status:blocked` → `status:ready`; `#403`/`#404`/`#405`/`#406`/`#408` (M8) **tetap** `status:blocked`. Detail: `docs/awcms-mini/06_github_issues_detail.md` §Koreksi urutan sprint (2).

### RBAC/ABAC access control 2.4 completed (2026-07-05)

Issue [#379](https://github.com/ahliweb/awcms-mini/issues/379) ditutup `completed` setelah migrasi `sql/005_awcms_mini_abac_access_control_schema.sql` menambahkan `awcms_mini_permissions` (katalog global, diseed 17 entri generik untuk modul base, RLS-free), `awcms_mini_roles`, `awcms_mini_role_permissions`, `awcms_mini_access_assignments`, `awcms_mini_abac_policies`, dan `awcms_mini_abac_decision_logs` (append-only). Evaluator murni `evaluateAccess` (default deny, deny overrides allow — ADR-0004) memakai tipe persis doc 10 §ABAC guard; dua aturan ABAC generik (tenant isolation, self-approval deny) dicek sebelum RBAC. Endpoint baru: `GET /access/modules`, `POST /access/evaluate`, `POST /access/assignments` (idempotent), `GET /access/decision-logs`. Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan: operator dengan role granted diizinkan, operator tanpa permission cocok ditolak (default deny), **operator tanpa role sama sekali ditolak (403) pada endpoint guarded** — membuktikan acceptance criteria "operator ditolak akses modul yang tidak diizinkan". Epic M2 (2.1-2.4) tuntas. Label `#407` (12.1 Setup Wizard) `status:blocked` → `status:ready`.

### Identity login schema 2.3 completed (2026-07-05)

Issue [#378](https://github.com/ahliweb/awcms-mini/issues/378) ditutup `completed` setelah migrasi `sql/004_awcms_mini_identity_login_schema.sql` menambahkan `awcms_mini_identities` (login per tenant, password hash argon2id via `Bun.password`, lockout), `awcms_mini_tenant_users` (status keanggotaan), dan `awcms_mini_sessions` (token opaque, hanya hash disimpan). Endpoint live pertama yang menyentuh database: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. Infrastruktur baru: `src/lib/database/client.ts`, `src/lib/database/tenant-context.ts` (`withTenant`/`assertUuid`, `SET LOCAL app.current_tenant_id`), `src/lib/auth/password.ts`, `src/lib/auth/session-token.ts`. Domain logic murni `evaluateLoginAttempt` (anti user-enumeration, lockout otomatis). Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan: login sukses/gagal, tenant inactive ditolak, lockout setelah 5 percobaan gagal, logout benar-benar mencabut sesi. Label `#379` (2.4) `status:blocked` → `status:ready` (Sprint 2 tuntas).

### Central profile schema 2.2 completed (2026-07-05)

Issue [#377](https://github.com/ahliweb/awcms-mini/issues/377) ditutup `completed` setelah migrasi `sql/003_awcms_mini_central_profile_management_schema.sql` menambahkan `awcms_mini_profiles`, `awcms_mini_profile_identifiers` (dedup + masking, identifier type digenerikkan dari NPWP/NIK/"customer code" di doc 03), `awcms_mini_profile_channels`, `awcms_mini_profile_addresses`, `awcms_mini_profile_entity_links`, `awcms_mini_profile_merge_requests` (constraint source ≠ target), dan `awcms_mini_profile_audit_logs` (append-only), plus domain logic murni (`normalizeIdentifier`/`hashIdentifier`/`maskIdentifier`/`assertMergeRequestIsValid`) dan modul `profile-identity` terdaftar. Diverifikasi langsung terhadap container PostgreSQL 16: migration apply bersih, dedup identifier menolak duplikat aktif namun mengizinkan reuse setelah soft delete, dan constraint merge source=target ditolak database.

### Tenant/office schema 2.1 completed + koreksi sprint (2026-07-05)

Issue [#376](https://github.com/ahliweb/awcms-mini/issues/376) ditutup `completed` setelah migrasi `sql/002_awcms_mini_tenant_office_schema.sql` menambahkan `awcms_mini_tenants`, `awcms_mini_offices`, `awcms_mini_physical_locations`, `awcms_mini_tenant_settings` dengan RLS tenant isolation dan soft delete pada tabel office-scoped, plus modul `tenant-admin` terdaftar. Diverifikasi langsung terhadap container PostgreSQL 16 (bukan hanya build/test): migration apply bersih, RLS mengisolasi role non-superuser per tenant, duplicate `office_code` aktif ditolak, dan kode bisa dipakai ulang setelah soft delete.

Saat scoping issue ini, ditemukan Issue [#407](https://github.com/ahliweb/awcms-mini/issues/407) (12.1 — Setup Wizard) salah sequencing: butuh skema tenant/identity/RBAC dari #376/#378/#379 (Sprint 2/3), tapi sebelumnya di Sprint 1 sejajar 0.1-0.3. Label disesuaikan: `#376`/`#377`/`#378` `status:blocked` → `status:ready`; `#407` `status:ready` → `status:blocked` (komentar penjelasan ditambahkan di issue). Detail: `docs/awcms-mini/06_github_issues_detail.md` §Koreksi urutan sprint, `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`.

### API contract 0.3 completed (2026-07-05)

Issue [#373](https://github.com/ahliweb/awcms-mini/issues/373) ditutup `completed` setelah commit `f7f66e7` menambahkan baseline OpenAPI (`openapi/awcms-mini-public-api.openapi.yaml`), baseline AsyncAPI (`asyncapi/awcms-mini-domain-events.asyncapi.yaml`), validator `scripts/api-spec-check.ts`, script `bun run api:spec:check`, shared response/error schema, pola soft delete/restore/purge, header HMAC sync, domain event envelope, dan test validator.

### Migration runner 0.2 completed (2026-07-05)

Issue [#372](https://github.com/ahliweb/awcms-mini/issues/372) ditutup `completed` setelah commit `9bbbae4` menambahkan runner migrasi PostgreSQL Bun-native (`scripts/db-migrate.ts`), script `bun run db:migrate`, checksum SHA-256, skip applied migration, deteksi checksum drift, advisory lock, transaction boundary runner, redaksi `DATABASE_URL`, test helper, dan panduan `docs/awcms-mini/database-migrations.md`.

### Foundation 0.1 completed (2026-07-05)

Issue [#371](https://github.com/ahliweb/awcms-mini/issues/371) ditutup `completed` setelah commit `f09a5a1` menambahkan Astro foundation build, health endpoint `/api/v1/health`, module contract/registry, API response helper, soft-delete convention, `.env.example`, foundation SQL schema, folder standar, unit test foundation, dan CI build gate.

### Reconciliation #2 (2026-07-04, lanjutan)

Audit menyeluruh (bandingkan **setiap field** tiap issue — Problem/Scope/Out of Scope/Acceptance Criteria/Security Notes/Testing/Reference Docs — terhadap `docs/awcms-mini/06_github_issues_detail.md` per issue, plus label & milestone terhadap tabel rekomendasi doc 06) menemukan 14 dari 18 issue open masih drift dari doc 06 saat ini. **Tidak ada perubahan jumlah/label/milestone** (tetap 18 open, 20 closed, 98 label, 24 milestone — semua label doc 06 terverifikasi ada di GitHub, semua milestone issue terverifikasi cocok tabel rekomendasi). Perbaikan hanya pada **body issue**:

- **2 konflik konten nyata** (leftover bahasa domain dari sebelum genericization, belum ikut ter-update saat itu):
  - **#371** (0.1): "Out of Scope" masih menyebut "POS, inventory, provider eksternal" → diganti "modul domain aplikasi turunan (katalog, transaksi, dsb.)" sesuai doc 06.
  - **#377** (2.2): "Acceptance Criteria" masih menyebut "user/customer/tax/CRM" → diganti "entitas modul lain" sesuai doc 06.
- **12 issue dengan Reference Docs basi** (dibuat sebelum `docs/adr/` dan doc 20 ada, tidak ikut diperbarui saat #379/#405 direconcile sebelumnya): #371, #372, #373 (Epic 0 → +ADR 0001-0002, 0007), #376, #377, #378 (Epic 2 → +ADR 0003-0004), #391, #392, #393 (Epic 6 → +ADR 0006), #403, #404 (Epic 10 → +doc 20 +ADR 0003-0005, menyamakan pola #405), #406 (Epic 11 → +ADR 0004).
- Issue yang **sudah cocok** tanpa perubahan: #379, #398, #401, #405, #407, #408 (Reference Docs sudah sesuai tabel doc 06 — epic 8/9/12 memang tidak punya ADR spesifik di tabel).

### Reconciliation #1 (2026-07-05)

Setelah penambahan standar profesional repo publik (lisensi MIT, governance/community files, ADR `docs/adr/`, doc 20 threat model, CI kualitas dokumentasi), issue GitHub diselaraskan dengan kondisi terbaru saat itu:

- **#405** (10.3 — Production Security Readiness): Reference Docs ditambah doc 20 (threat model) + ADR 0003–0005; readiness wajib memverifikasi kontrol pada threat model dan konsisten dengan ADR.
- **#379** (2.4 — RBAC and ABAC): Reference Docs ditambah doc 20 + `docs/adr/0004-rbac-abac-default-deny.md`.

Backlog `docs/awcms-mini/06_github_issues_detail.md` §Dokumen acuan per epic juga diselaraskan untuk merujuk ADR + doc 20 per epic. (Reconciliation #1 ini ternyata tidak lengkap — 12 issue lain baru menyusul di Reconciliation #2 di atas.)

### Genericization (2026-07-04)

Repository awcms-mini adalah **contoh repo pengembangan umum** (base modular monolith reusable), bukan aplikasi domain. Backlog awal (38 issue, aktivasi pertama pada hari yang sama) ternyata memuat epic domain POS/retail yang salah tempat. Perbaikan yang dilakukan:

- **20 issue ditutup** (`not planned`, dengan komentar penjelasan): Legacy Migration (1.1-1.2), POS MVP (3.1-3.4), Warehouse Management (4.1-4.4), CRM Receipt Delivery (5.1-5.3), Accounting/Coretax (7.1-7.4), POS UI (8.2), Receipt Portal (8.3), AI Business Analyst (9.2).
- **2 issue digeneralisasi**: 8.1 "Build Admin/Petugas Layout Shell" → "Build Admin Layout Shell"; 9.1 scope diubah dari view POS/tax/warehouse-specific menjadi view generik (tenant activity, access/audit summary, sync health, module usage).
- **7 label dihapus** (dibuat keliru pada aktivasi pertama, tidak relevan untuk base generik): `area:pos`, `area:warehouse`, `area:tax`, `area:crm`, `area:ai`, `area:migration`, `area:inventory`.
- **4 milestone dihapus** (jadi kosong setelah issue domain ditutup): `M1 — Legacy Migration & Data Model`, `M3 — POS MVP`, `M4 — Inventory & Warehouse`, `M6 — Tax/Coretax Readiness`.
- **2 milestone di-rename**: `M5 — CRM, Receipt, Sync` → `M5 — Sync Storage` (drop CRM); `M7 — Reporting, AI, UI/UX` → `M7 — UI/UX & Reporting` (drop AI).
- **Docs diperbaiki** agar konsisten dengan base generik: `docs/awcms-mini/06_github_issues_detail.md` ditulis ulang (backlog 18 issue), `docs/awcms-mini/01_canvas_induk.md` ditulis ulang (hapus modul/fase domain), `AGENTS.md` §Peta modul dan `docs/awcms-mini/09_roadmap_repository_commit.md` §Struktur source diperbaiki (hapus daftar modul domain).
- **Label/milestone peninggalan** SIKESRA/governance-overlay era (73 label, 19 milestone) **tidak disentuh** — bukan buatan sesi ini, di luar wewenang untuk dihapus.

## Hubungan dengan dokumen utama

- `docs/awcms-mini/06_github_issues_detail.md` adalah rencana/template issue atomic generik; sebagian issue sudah selesai dan sisanya tercatat di snapshot open.
- `docs/awcms-mini/github/` adalah snapshot state GitHub aktual.
- `docs/awcms-mini/github/security.md` mencatat setup GitHub Security dan alert count saat refresh.
- `docs/awcms-mini/09_roadmap_repository_commit.md` mengatur urutan branch, commit, PR, release, dan changeset.
- `AGENTS.md` tetap menjadi kontrak kerja agent dan developer.
- Metadata GitHub tidak menjadi otoritas arsitektur; arsitektur target tetap Bun + Astro 7 + PostgreSQL sesuai dokumen utama.
