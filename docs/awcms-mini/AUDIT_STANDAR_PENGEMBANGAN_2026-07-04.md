# Audit Standar Pengembangan Software AWCMS-Mini — 2026-07-04

## Ringkasan verdict

Status repository terbaru: **PASS untuk baseline perencanaan dan foundation skeleton Issue 0.1**. Runtime aplikasi penuh belum selesai karena tenant/auth/RBAC/sync/deployment masih berada di backlog, tetapi scaffold Astro/Bun, health endpoint, module contract, response helper, soft-delete convention, dan folder standar sudah tersedia.

Stack target sudah konsisten di dokumen:

- Runtime: **Bun**.
- Package manager: **Bun** (`packageManager: bun@1.3.14`).
- Backend platform: **Bun-only**. Node.js tidak boleh dipakai kecuali ada izin maintainer dan catatan pengecualian di docs karena Bun belum mendukung kebutuhan teknis terkait.
- Web framework: **Astro 7**.
- Database: **PostgreSQL**.
- Arsitektur: modular monolith, microservice-ready.
- Kontrak: OpenAPI + AsyncAPI.
- Security baseline: RBAC + ABAC + PostgreSQL RLS + audit log.

## Lingkup audit

Audit membaca seluruh isi repo saat ini:

- Root docs dan metadata: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `.gitignore`, `package.json`, `.changeset/`.
- Paket dokumen `docs/awcms-mini/01` sampai `20` + Architecture Decision Records di `docs/adr/`.
- Snapshot GitHub issue aktual di `docs/awcms-mini/github/`.
- Skill dan subagent proyek di `.claude/skills/` dan `.claude/agents/`.
- Struktur aktual repository dan gap terhadap target Issue 0.1.

## Temuan utama

| Area                      | Status                 | Catatan                                                                                                                                                            |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status repo               | PASS                   | Repo jujur menyatakan foundation skeleton sudah tersedia, tetapi belum mengklaim app production-ready.                                                             |
| Stack target              | PASS                   | Bun, Astro 7, dan PostgreSQL konsisten di README, AGENTS, doc 01, 10, 11, 13, 15, 16, 18.                                                                          |
| Backend platform Bun-only | PASS                   | Dokumen menetapkan Bun sebagai runtime backend dan melarang Node.js/tooling npm-family tanpa pengecualian tertulis.                                                |
| Governance agent          | PASS                   | `AGENTS.md`, 17 skill, dan 3 subagent tersedia; alur implementasi/review/security jelas.                                                                           |
| Roadmap issue             | PASS                   | Issue 0.1–12.2 terdokumentasi; snapshot GitHub open/closed ada di `docs/awcms-mini/github/`; urutan implementasi tidak melompat ke POS sebelum tenant/auth/access. |
| Security baseline         | PASS                   | RBAC, ABAC default deny, RLS, audit, masking, idempotency, soft delete, HMAC sync, provider outbox tercakup.                                                       |
| Database standard         | PASS                   | Migration berurutan, PostgreSQL types, RLS, index/FK, transaction wrapper, locking, outbox, pooling terdokumentasi.                                                |
| API/event contract        | PASS                   | OpenAPI/AsyncAPI, response/error shape, idempotency header, soft delete API, tombstone event terdokumentasi.                                                       |
| Frontend standard         | PASS                   | Astro SSR/islands, PWA/offline-first, IndexedDB outbox, API client, a11y, i18n, design token terdokumentasi.                                                       |
| Testing & readiness       | PASS                   | Unit/integration/contract/security/performance target dan production preflight sudah ada.                                                                          |
| Versioning                | PASS setelah perbaikan | Changesets tersedia; `bun.lock` ditambahkan untuk reproducible install.                                                                                            |
| Runtime source            | PASS sebagian          | `src/`, `sql/`, `openapi/`, `asyncapi/`, `tests/`, `astro.config.mjs`, dan `.env.example` tersedia; `docker-compose.yml` dan runner detail masuk issue berikutnya. |
| Security automation       | PASS                   | `SECURITY.md`, Dependabot config, CodeQL workflow untuk GitHub Actions, secret scanning, push protection, dan private vulnerability reporting tersedia.            |
| CI build/test workflow    | PASS sebagian          | CI menjalankan lint, docs-check, typecheck, `bun test`, build Astro, Bun-only hygiene, dan no-`.env`; spec/migration check masuk issue 0.2/0.3.                    |

## Standar yang sudah terpenuhi sebagai baseline

### 1. Software development lifecycle

- Atomic issue/sprint diwajibkan.
- DoD mencakup migration, OpenAPI, AsyncAPI, test, build, docs, changeset, laporan implementasi.
- Branch dan commit convention sudah ditetapkan.
- Versioning memakai SemVer + Changesets.
- Review PR dan security review punya skill/subagent khusus.

### 2. Bun

- `package.json` sudah memakai `type: "module"` dan script Changesets.
- `bun.lock` sudah tersedia untuk mengunci dependency baseline.
- `package.json` mengunci package manager ke `bun@1.3.14`.
- Script Bun aktif: `dev`, `build`, `preview`, `start`, `lint`, `check:docs`, `typecheck`, `test`, `test:coverage`, `check`, dan Changesets. Target script berikutnya tetap `db:migrate`, `api:spec:check`, `api:contract:test`, `security:readiness`, `production:preflight`, `db:pool:health`.
- Node.js exception protocol sudah didefinisikan di `AGENTS.md`, doc 10, doc 12, dan doc 16.

### 2.1 Pengecualian Node.js

Status saat audit: **tidak ada pengecualian Node.js yang disetujui**.

Jika di masa depan Bun belum mendukung kebutuhan teknis tertentu, pengecualian wajib dicatat di tabel ini sebelum merge:

| Tanggal | Scope | Alasan Bun belum cukup | Izin maintainer | Alternatif Bun yang dicoba | Rencana pencabutan |
| ------- | ----- | ---------------------- | --------------- | -------------------------- | ------------------ |
| —       | —     | —                      | —               | —                          | —                  |

Catatan: script aplikasi foundation sudah ada di `package.json`; script database/API/deployment readiness menunggu issue 0.2/0.3/10.3/12.2.

### 3. Astro 7

- Astro 7 dipilih eksplisit sebagai framework.
- Doc 15 menetapkan Astro output server/SSR, islands untuk area interaktif, cookie httpOnly untuk sesi, dan service worker/IndexedDB untuk POS offline.
- Doc 14 menetapkan design token, komponen UI, state pattern, a11y WCAG 2.1 AA, i18n, dan layout admin/POS/customer.
- **Astro berjalan penuh di runtime Bun** (install/dev/build/runtime); bin Astro/Vite dipanggil `bun --bun`. Astro belum punya adapter SSR Bun first-party, sehingga SSR memakai salah satu opsi tersanksi (doc 15 §Astro SSR di atas runtime Bun): (A) seam API `Bun.serve`+Hono dengan Astro sebagai frontend — rekomendasi, atau (B) `@astrojs/node` standalone dijalankan `bun ./dist/server/entry.mjs`. Opsi B = satu-satunya pemakaian paket ber-nama "node" yang diizinkan (binary `node` tidak dipakai) dan wajib dicatat sebagai pengecualian di §2.1.

Catatan: `astro.config.mjs`, halaman index, dan health endpoint sudah tersedia. UI admin/komponen aplikasi tetap menunggu sprint UI.

### 4. PostgreSQL

- PostgreSQL menjadi database utama.
- Doc 04 menetapkan UUID PK, `timestamptz`, `numeric`, FK index, RLS, migration berurutan, data classification, retention, dan soft delete.
- Doc 16 menetapkan akses data konkret: repository, parameterized query, `SET LOCAL app.current_tenant_id`, transaction wrapper, `FOR UPDATE`, outbox, pooling/backpressure, PgBouncer transaction mode, idempotency store.

Catatan: `sql/001_awcms_mini_foundation_schema.sql` sudah tersedia. Migration runner detail tetap target Issue 0.2.

## Gap yang harus ditutup saat implementasi

| Prioritas | Gap                                                                                                          | Target penyelesaian                                  |
| --------: | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
|        P0 | Docker Compose/deployment profile belum ada.                                                                 | Issue 12.2                                           |
|        P0 | Migration runner, OpenAPI/AsyncAPI validator, dan contract test belum ada.                                   | Issue 0.2–0.3                                        |
|        P0 | Spec check OpenAPI/AsyncAPI belum ada.                                                                       | Tambahkan pada Issue 0.3                             |
|        P1 | Markdown/link/spec lint belum otomatis.                                                                      | Tambahkan script docs/spec validation pada Issue 0.3 |
|        P1 | Runtime enforcement belum bisa diuji: TypeScript strict, RLS integration, ABAC, idempotency, audit, masking. | Mulai Issue 2.1–3.4 sesuai urutan                    |
|        P1 | Production preflight masih berupa target script.                                                             | Issue 10.3 dan Sprint 12                             |

## Verifikasi yang dijalankan

```bash
bun --version
bun install --lockfile-only
bun install --frozen-lockfile
```

Hasil:

- Bun tersedia: `1.3.14`.
- `bun.lock` berhasil dibuat.
- `bun install --frozen-lockfile` berhasil setelah lockfile tersedia.

## Keputusan audit

1. Repository **sudah sesuai standar sebagai planning baseline** untuk pengembangan software Bun + Astro + PostgreSQL.
2. Repository **sudah buildable sebagai foundation skeleton Bun/Astro**, tetapi belum boleh diklaim sebagai aplikasi production-ready sampai tenant/auth/RBAC/database runner/API contract/deployment selesai.
3. Tidak ada secret nyata yang terdeteksi; nilai seperti `change-me` dan `awcms_mini_password` hanya placeholder dokumentasi `.env.example`.
4. Perbaikan yang dilakukan dari audit ini:
   - `CHANGELOG.md` disesuaikan dari 14 skill menjadi 17 skill.
   - `bun.lock` ditambahkan untuk reproducible dependency baseline.
   - Dokumen audit ini ditambahkan sebagai rujukan repo-local.
   - Snapshot GitHub issue open/closed, label, milestone, security, dan proses refresh ditambahkan di `docs/awcms-mini/github/`; snapshot live 2026-07-04T11:16:36Z mencatat 0 issue, 76 label, 19 milestone, 0 open Dependabot alert, 0 open code-scanning alert, dan 0 secret-scanning alert.
   - Backlog doc 06 diaktifkan penuh di GitHub pada 2026-07-04T13:58:45Z: 38 issue (`#371`-`#408`), 29 label baru + 9 milestone baru (`M0`-`M8`) sesuai taksonomi doc 06, tanpa menghapus 73 label/19 milestone peninggalan proyek sebelumnya. Detail: `docs/awcms-mini/github/README.md`.
   - **Genericization pada 2026-07-04T14:15:43Z**: 38 issue awal ternyata memuat epic domain POS/retail yang tidak sesuai konteks AWCMS-Mini sebagai contoh repo pengembangan umum. 20 issue domain ditutup (`not planned`), 2 issue digeneralisasi wording-nya, 7 label domain dan 4 milestone domain yang jadi kosong dihapus, 2 milestone di-rename (drop CRM/AI). `docs/awcms-mini/06_github_issues_detail.md` dan `docs/awcms-mini/01_canvas_induk.md` ditulis ulang menjadi generik; `AGENTS.md` §Peta modul dan `docs/awcms-mini/09_roadmap_repository_commit.md` §Struktur source diperbaiki agar tidak lagi mencantumkan modul domain (katalog, POS, gudang, pajak, CRM, AI analyst) sebagai bagian base. Detail: `docs/awcms-mini/github/README.md` §Genericization.
   - `SECURITY.md`, `.github/dependabot.yml`, dan `.github/workflows/codeql.yml` ditambahkan sebagai baseline GitHub Security.
   - **Pengerasan standar repo publik pada 2026-07-05**: lisensi `UNLICENSED` → **MIT** (`LICENSE`); berkas komunitas & tata kelola (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `SUPPORT.md`, `.github/CODEOWNERS`, PR/issue templates); konfigurasi kualitas (`.editorconfig`, `.gitattributes`, `.prettierrc.json`); CI kualitas dokumentasi (`.github/workflows/ci.yml` + `scripts/check-docs.mjs`: validasi mermaid/tautan/penamaan, gate Bun-only/no-`.env`); **Architecture Decision Records** `docs/adr/` (0001–0007); **doc 20 — Threat Model & Arsitektur Keamanan**; `SECURITY.md` diperluas (scope, safe harbor, target response time). Berkas cruft `init` (1 byte) dihapus. Seluruh Markdown dijadikan prettier-clean. Issue GitHub `#405`/`#379` diselaraskan untuk merujuk doc 20 + ADR.
   - Tambah `tsconfig.json` baseline + `typescript`/`@types/bun`/`@types/node`, script `typecheck`; rilis `0.0.1`.
   - Tambah **unit testing** (`bun test`): refaktor `scripts/check-docs.mjs` menjadi lib murni (`scripts/lib/docs-checks.mjs`) + CLI tipis, `tests/docs-checks.test.mjs` (23 kasus) + `tests/check-docs-integration.test.mjs`; perbaiki bug fidelity `slugify` (GitHub tidak collapse whitespace beruntun); `bun test` masuk gate CI; rilis `0.0.2`.
   - **Audit menyeluruh GitHub vs doc 06 pada 2026-07-04T22:11:08Z**: membandingkan setiap field (Problem/Scope/Out of Scope/Acceptance Criteria/Security Notes/Testing/Reference Docs) tiap issue open terhadap doc 06, plus label & milestone terhadap tabel rekomendasi. Ditemukan 14/18 issue drift: 2 **konflik konten nyata** (leftover bahasa domain "POS, inventory" di `#371` dan "user/customer/tax/CRM" di `#377`, tersisa dari genericization sebelumnya) + 12 issue dengan Reference Docs basi (dibuat sebelum `docs/adr/`/doc 20 ada). Semua diperbaiki di GitHub tanpa mengubah jumlah/label/milestone (tetap 18 open/20 closed/98 label/24 milestone — 100% cocok tabel doc 06 setelah perbaikan). Detail: `docs/awcms-mini/github/README.md` §Reconciliation #2.
   - **Issue 0.1 foundation skeleton**: Astro 7 ditambahkan, `bun run build` lulus, health endpoint `/api/v1/health` tersedia, `src/modules/_shared/` menyediakan module contract, response helper, soft-delete convention, `src/modules/index.ts` menjadi registry awal, `.env.example` placeholder tersedia, dan folder standar `src/`, `sql/`, `openapi/`, `asyncapi/`, `deploy/`, `fixtures/` dibuat. CI dan `bun run check` menjalankan build. Issue GitHub `#371` ditutup `completed` pada 2026-07-05; snapshot GitHub terbaru menjadi 17 open / 21 closed.
   - **Issue 0.2 SQL migration runner**: `scripts/db-migrate.ts` ditambahkan dengan `Bun.SQL`, advisory lock, checksum SHA-256, skip applied migration, deteksi checksum drift, transaction boundary runner, redaksi `DATABASE_URL`, test helper, script `bun run db:migrate`, dan panduan `docs/awcms-mini/database-migrations.md`. Issue GitHub `#372` ditutup `completed` pada 2026-07-05; snapshot GitHub terbaru menjadi 16 open / 22 closed.
   - **Issue 0.3 OpenAPI/AsyncAPI baseline**: `openapi/awcms-mini-public-api.openapi.yaml`, `asyncapi/awcms-mini-domain-events.asyncapi.yaml`, dan `scripts/api-spec-check.ts` ditambahkan. Kontrak mencakup response/error schema bersama, health endpoint, pola soft delete/restore/purge, header HMAC sync, domain event envelope, dan validasi konsistensi event module registry. Issue GitHub `#373` ditutup `completed` pada 2026-07-05; snapshot GitHub terbaru menjadi 15 open / 23 closed.
   - **Perbaikan arsitektur SSR + kontrak response pada 2026-07-05**: audit pasca-Issue 0.1–0.3 menemukan dua konflik: (1) `astro.config.mjs` memakai `output: "static"` dan `health.ts` memakai `prerender = true`, sehingga `/api/v1/health` menjadi file JSON hasil build, bukan endpoint hidup — bertentangan dengan arsitektur middleware per-request di doc 01/09/16 dan ADR-0002, serta membuat `AGENTS.md` (`bun run start # bun ./dist/server/entry.mjs`) tidak akurat karena `dist/server/entry.mjs` tidak ada; (2) `src/modules/_shared/api-response.ts` dan `openapi/awcms-mini-public-api.openapi.yaml` memakai field envelope `ok: true/false`, padahal doc 05 dan doc 10 menetapkan `success: true/false`. Perbaikan: `astro.config.mjs` → `output: "server"` + adapter `@astrojs/node` (mode `standalone`, pengecualian Bun-only tersanksi sesuai ADR-0002/doc 10/doc 18), `prerender` dihapus dari `health.ts`; seluruh envelope `ok` → `success` (kode, OpenAPI, test, `src/modules/_shared/README.md`); `package.json` `start` diperbaiki jadi `bun ./dist/server/entry.mjs`; `lint`/`format` diperluas mencakup `.ts`/`.mjs`/`.astro` (plus `prettier-plugin-astro`). Diverifikasi dengan menjalankan server hasil build sungguhan dan memanggil `/api/v1/health` dua kali — `generatedAt` berbeda antar-request, membuktikan SSR dinamis (bukan file statis), dan payload memakai `"success":true`.
   - **Rilis `0.1.0` pada 2026-07-05**: 4 changeset yang terkumpul (`foundation-skeleton`, `db-migration-runner`, `api-contract-baseline`, `pin-ci-actions`) dikonsumsi lewat `bun run changeset:version`; `CHANGELOG.md` direkonsiliasi menjadi bagian Added/Changed/Fixed yang bersih. Tabel peta versi doc 09 diperbaiki: sebelumnya `v0.1.0` menumpuk "Foundation, tenant, identity, profile" dalam satu slot, padahal baru Foundation yang selesai — dipecah jadi `v0.1.0` (Foundation) dan `v0.2.0` (tenant/identity/profile), versi setelahnya digeser (`v0.3.0` RBAC/ABAC … `v1.0.0` production-ready); tabel yang sama di `CHANGELOG.md` §Peta versi rencana disinkronkan. `README.md` §Versioning diperbarui merujuk `0.1.0`.
   - **Perbaikan item menengah/rendah pada 2026-07-05**: (1) tipe `SoftDeleteColumns.deletedAt`/`deletedBy`/`deleteReason` di `src/modules/_shared/soft-delete.ts` disamakan ke `string | null` opsional sesuai doc 10 (sebelumnya `deletedAt: Date | null` wajib); (2) `.env.example` dan doc 11 §Minimal `.env.example` — baris `STARSENDER_ENABLED`/`MAILKETING_ENABLED`/`AI_ANALYST_ENABLED` (nama provider spesifik-domain retail/POS) dihapus dari file konfigurasi nyata base, diganti komentar generik yang merujuk aplikasi turunan menambah flag provider-nya sendiri (contoh domain tetap ada di doc 18); (3) doc 13 §Repository artifact checklist ditambah subbagian "Folder standar" yang mengindeks `README.md` di `src/lib/`, `src/modules/_shared/`, `openapi/`, `asyncapi/`, `deploy/`, `fixtures/`.
   - **Koreksi urutan sprint & Issue 2.1 — Tenant/Office Schema pada 2026-07-05**: rekomendasi sebelumnya untuk langsung mengerjakan Issue 12.1 (Setup Wizard) ternyata keliru — 12.1 menginisialisasi tenant/owner/office/role/permission/ABAC, padahal skema database saat itu baru berisi `awcms_mini_modules`/`awcms_mini_schema_migrations` (Issue 0.1–0.3). Skema tenant/identity/RBAC adalah scope Issue 2.1, 2.3, 2.4 (Sprint 2/3), sedangkan doc 06 sebelumnya menempatkan 12.1 di Sprint 1 sejajar 0.1–0.3. Diperbaiki: 12.1 dipindah ke Sprint 3 (setelah 2.4) di `docs/awcms-mini/06_github_issues_detail.md` §Sprint awal rekomendasi + §Koreksi urutan sprint (baru); label GitHub disesuaikan — `#376`/`#377`/`#378` (2.1/2.2/2.3) `status:blocked` → `status:ready` (dependency Sprint 1 sudah selesai), `#407` (12.1) `status:ready` → `status:blocked` (dependency nyata: 2.1/2.3/2.4).
     - **Issue 2.1 diimplementasikan**: migrasi `sql/002_awcms_mini_tenant_office_schema.sql` menambahkan `awcms_mini_tenants` (root tenant, unique `tenant_code`, lifecycle `status` tanpa soft delete), `awcms_mini_offices` (hierarki kantor per tenant, unique parsial `(tenant_id, office_code) WHERE deleted_at IS NULL`, RLS tenant isolation, soft delete), `awcms_mini_physical_locations` (alamat per office, RLS, soft delete), dan `awcms_mini_tenant_settings` (konfigurasi 1:1 per tenant, RLS) — seluruhnya generik (bukan mengambil contoh domain retail dari doc 17). Nama file migration `002` diperbaiki dari rencana awal "`tenant_identity_schema`" (menggabungkan Issue 2.1+2.3) menjadi "`tenant_office_schema`" agar satu migration = satu issue; identity/login (2.3) akan mendapat nomor migration tersendiri. Modul `tenant-admin` (`src/modules/tenant-admin/module.ts`, status `experimental`) didaftarkan di `src/modules/index.ts`. Test baru: registry modul tidak lagi kosong, `discoverMigrationFiles()` menemukan `002` secara berurutan dan checksum valid, serta memverifikasi RLS + kolom soft-delete ada di isi migration (36 test total, semua lulus). Issue GitHub `#376` ditutup `completed`.

## Rekomendasi berikutnya

Urutan paling aman:

1. Issue 2.1 (tenant/office schema) selesai. Lanjut Issue 2.2 (Central Profile Schema) dan 2.3 (Identity Login and Tenant User Membership) — keduanya Sprint 2, sudah `status:ready`.
2. Setelah 2.1–2.3 selesai, kerjakan Issue 2.4 (RBAC/ABAC Access Control, Sprint 3) — evaluator default deny/deny overrides allow generik (bukan matriks role retail doc 17).
3. Baru setelah 2.4 selesai, kerjakan Issue 12.1 (Setup Wizard API) — saat itu skema tenant/identitas/RBAC/ABAC sudah tersedia untuk diinisialisasi.
4. Target versi: `v0.2.0` = tenant/identity/profile (2.1–2.3) per doc 09 §Versioning; `v0.3.0` = RBAC/ABAC (2.4) menyusul 12.1 di Sprint 3 yang sama.
5. Tidak ada item menengah/rendah terbuka dari audit ini yang memblokir Issue 2.2/2.3.
