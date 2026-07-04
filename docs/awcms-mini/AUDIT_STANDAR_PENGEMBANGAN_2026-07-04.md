# Audit Standar Pengembangan Software AWCMS-Mini — 2026-07-04

## Ringkasan verdict

Status repository saat audit: **PASS untuk baseline perencanaan docs-only**, **BELUM BERLAKU untuk runtime application compliance** karena kode aplikasi memang belum dibuat. README dan AGENTS menyatakan kondisi ini eksplisit: AWCMS-Mini masih paket perencanaan, dan implementasi aplikasi dimulai dari Issue 0.1.

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
- Paket dokumen `docs/awcms-mini/01` sampai `19`.
- Snapshot GitHub issue aktual di `docs/awcms-mini/github/`.
- Skill dan subagent proyek di `.claude/skills/` dan `.claude/agents/`.
- Struktur aktual repository dan gap terhadap target Issue 0.1.

## Temuan utama

| Area                      | Status                 | Catatan                                                                                                                                                            |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status repo               | PASS                   | Repo jujur menyatakan docs-only dan belum mengklaim app production-ready.                                                                                          |
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
| Runtime source            | N/A                    | `src/`, `sql/`, `openapi/`, `asyncapi/`, `tests/`, `astro.config.mjs`, `.env.example`, `docker-compose.yml` belum ada karena masuk scope Issue 0.1.                |
| Security automation       | PASS                   | `SECURITY.md`, Dependabot config, CodeQL workflow untuk GitHub Actions, secret scanning, push protection, dan private vulnerability reporting tersedia.            |
| CI build/test workflow    | GAP terencana          | Workflow build/test/spec aplikasi belum ditambahkan karena script runtime masuk scope Issue 0.1.                                                                   |

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
- Target script Bun lengkap sudah didefinisikan di doc 11: `dev`, `build`, `db:migrate`, `api:spec:check`, `api:contract:test`, `test`, `security:readiness`, `production:preflight`, `db:pool:health`.
- Node.js exception protocol sudah didefinisikan di `AGENTS.md`, doc 10, doc 12, dan doc 16.

### 2.1 Pengecualian Node.js

Status saat audit: **tidak ada pengecualian Node.js yang disetujui**.

Jika di masa depan Bun belum mendukung kebutuhan teknis tertentu, pengecualian wajib dicatat di tabel ini sebelum merge:

| Tanggal | Scope | Alasan Bun belum cukup | Izin maintainer | Alternatif Bun yang dicoba | Rencana pencabutan |
| ------- | ----- | ---------------------- | --------------- | -------------------------- | ------------------ |
| —       | —     | —                      | —               | —                          | —                  |

Catatan: script aplikasi belum ada di `package.json` karena repository belum melewati Issue 0.1.

### 3. Astro 7

- Astro 7 dipilih eksplisit sebagai framework.
- Doc 15 menetapkan Astro output server/SSR, islands untuk area interaktif, cookie httpOnly untuk sesi, dan service worker/IndexedDB untuk POS offline.
- Doc 14 menetapkan design token, komponen UI, state pattern, a11y WCAG 2.1 AA, i18n, dan layout admin/POS/customer.
- **Astro berjalan penuh di runtime Bun** (install/dev/build/runtime); bin Astro/Vite dipanggil `bun --bun`. Astro belum punya adapter SSR Bun first-party, sehingga SSR memakai salah satu opsi tersanksi (doc 15 §Astro SSR di atas runtime Bun): (A) seam API `Bun.serve`+Hono dengan Astro sebagai frontend — rekomendasi, atau (B) `@astrojs/node` standalone dijalankan `bun ./dist/server/entry.mjs`. Opsi B = satu-satunya pemakaian paket ber-nama "node" yang diizinkan (binary `node` tidak dipakai) dan wajib dicatat sebagai pengecualian di §2.1.

Catatan: `astro.config.mjs`, pages, dan komponen belum ada karena masih target Issue 0.1 dan sprint UI.

### 4. PostgreSQL

- PostgreSQL menjadi database utama.
- Doc 04 menetapkan UUID PK, `timestamptz`, `numeric`, FK index, RLS, migration berurutan, data classification, retention, dan soft delete.
- Doc 16 menetapkan akses data konkret: repository, parameterized query, `SET LOCAL app.current_tenant_id`, transaction wrapper, `FOR UPDATE`, outbox, pooling/backpressure, PgBouncer transaction mode, idempotency store.

Catatan: `sql/` dan migration runner belum ada karena masih target Issue 0.1–0.2.

## Gap yang harus ditutup saat implementasi

| Prioritas | Gap                                                                                                             | Target penyelesaian                                  |
| --------: | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
|        P0 | Scaffold runtime belum ada (`src/`, `astro.config.mjs`, `tsconfig.json`, `.env.example`, `docker-compose.yml`). | Issue 0.1                                            |
|        P0 | Migration runner, OpenAPI/AsyncAPI validator, dan contract test belum ada.                                      | Issue 0.2–0.3                                        |
|        P0 | CI workflow belum ada untuk `bun install --frozen-lockfile`, build, test, spec check.                           | Tambahkan di Issue 0.1/0.3 setelah script tersedia   |
|        P1 | Markdown/link/spec lint belum otomatis.                                                                         | Tambahkan script docs/spec validation pada Issue 0.3 |
|        P1 | Runtime enforcement belum bisa diuji: TypeScript strict, RLS integration, ABAC, idempotency, audit, masking.    | Mulai Issue 2.1–3.4 sesuai urutan                    |
|        P1 | Production preflight masih berupa target script.                                                                | Issue 10.3 dan Sprint 12                             |

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
2. Repository **belum boleh diklaim sebagai aplikasi Bun/Astro/PostgreSQL yang buildable** sampai Issue 0.1 selesai.
3. Tidak ada secret nyata yang terdeteksi; nilai seperti `change-me` dan `awcms_mini_password` hanya placeholder dokumentasi `.env.example`.
4. Perbaikan yang dilakukan dari audit ini:
   - `CHANGELOG.md` disesuaikan dari 14 skill menjadi 17 skill.
   - `bun.lock` ditambahkan untuk reproducible dependency baseline.
   - Dokumen audit ini ditambahkan sebagai rujukan repo-local.
   - Snapshot GitHub issue open/closed, label, milestone, security, dan proses refresh ditambahkan di `docs/awcms-mini/github/`; snapshot live 2026-07-04T11:16:36Z mencatat 0 issue, 76 label, 19 milestone, 0 open Dependabot alert, 0 open code-scanning alert, dan 0 secret-scanning alert.
   - `SECURITY.md`, `.github/dependabot.yml`, dan `.github/workflows/codeql.yml` ditambahkan sebagai baseline GitHub Security.

## Rekomendasi berikutnya

Urutan paling aman:

1. Kerjakan Issue 0.1 dan buat scaffold Bun + Astro 7 yang benar-benar buildable.
2. Tambahkan CI minimal setelah script tersedia.
3. Kerjakan Issue 0.2 dan 0.3 agar PostgreSQL migration + OpenAPI/AsyncAPI validator menjadi executable.
4. Baru lanjut ke setup wizard, tenant, profile, auth, ABAC, product, stock, checkout, dan posting sesuai urutan docs.
