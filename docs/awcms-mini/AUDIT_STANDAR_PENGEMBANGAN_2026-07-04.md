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

## Rekomendasi berikutnya

Urutan paling aman:

1. Kerjakan Issue 0.2 agar PostgreSQL migration runner executable.
2. Kerjakan Issue 0.3 agar OpenAPI/AsyncAPI validator executable.
3. Kerjakan Issue 12.1 untuk setup wizard API.
4. Baru lanjut ke tenant, profile, auth, ABAC, sync, UI, reporting, workflow, dan deployment sesuai urutan docs.
