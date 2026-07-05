# Changelog

Semua perubahan penting pada AWCMS-Mini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan proyek ini menganut [Semantic Versioning](https://semver.org/lang/id/). Entri versi dihasilkan/dikonsumsi lewat [Changesets](.changeset/README.md) (`bun run changeset` → `bun run changeset:version`).

## [Unreleased]

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

Nomor versi naik progresif per rilis, bukan hanya saat satu slot epic selesai penuh: rilis `0.2.0`-`0.4.0` berisi Issue 2.1 (tenant/office), 2.2 (central profile), dan 2.3 (identity/login) dari slot "Tenant, identity, profile" (tuntas); rilis `0.5.0` berisi Issue 2.4 (RBAC/ABAC) dari slot "RBAC/ABAC evaluator + assignment" (tuntas). Epic M2 (2.1–2.4) selesai penuh. Rilis `0.6.0` berisi Issue 12.1 (Setup Wizard) dan rilis `0.7.0` berisi Issue 6.1 (Sync Outbox/Inbox) — keduanya tidak punya slot eksplisit sendiri di tabel peta versi doc 09 (12.1 ditempatkan setelah M2, 6.1 dimulai dari slot "Sync storage" `v0.4.0` yang sebelumnya ditarget jauh lebih lambat dari realisasi progresif ini). Rilis `0.8.0` berisi Issue 6.2 (Sync Conflict Tracking/Resolution), lanjutan langsung dari slot "Sync storage" yang sama dengan 6.1. Rilis `0.9.0` berisi Issue 6.3 (R2 Object Sync Queue), menuntaskan epic M5 (Sync Storage) sepenuhnya. Rilis `0.10.0` berisi Issue 8.1 (Admin Layout Shell), issue pertama epic M7 (UI/UX & Reporting) dan issue frontend pertama di repo ini. Rilis `0.11.0` berisi Issue 9.1 (Management Reporting Views), menuntaskan epic M7 sepenuhnya. Rilis `0.11.1` adalah patch (bug fix jsonb double-encoding pada sync push, bukan issue baru). Rilis `0.12.0` berisi Issue 10.1 (Structured Logging and Audit Trail), issue pertama epic M8 (Security, Performance, Production). Rilis `0.13.0` berisi Issue 10.2 (Database Connection Pooling and Backpressure) — tidak ada migration baru, murni infrastruktur aplikasi.

[Unreleased]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.13.0...HEAD
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
