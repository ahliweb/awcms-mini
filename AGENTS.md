# AGENTS.md — Panduan Agent & Kontributor AWCMS-Mini

Dokumen ini adalah **kontrak kerja** untuk coding agent (Claude Code, Codex, dsb.) maupun developer manusia yang mengimplementasikan AWCMS-Mini. Setiap sesi implementasi **wajib membaca file ini terlebih dahulu**, lalu dokumen terkait di `docs/awcms-mini/`.

> **Status base generik: selesai (v0.23.5).** Seluruh 18 issue backlog base generik (doc 06) tuntas — foundation, tenant/office, central profile, identity/login, RBAC/ABAC, setup wizard, Sync Storage (outbox/inbox/conflict/object-queue), management reporting, structured logging & audit trail, connection pooling & backpressure, production readiness, workflow approval, dan deployment profile — plus perawatan/peningkatan pasca-backlog milestone M9 (penegakan RLS + role least-privilege, Access & Users / Sync / Settings admin, runtime i18n, audit UX/UI & aksesibilitas AA, audit performa, dispatcher object-sync + kerasan integrasi, security hardening OWASP/ASVS/ISO, dan aktivasi sistem log). Tabel tenant/auth/RBAC/sync/logging/deployment **sudah** ada dan berjalan — jangan membangunnya ulang. Pekerjaan baru = **aplikasi turunan / modul domain** di atas base ini (lihat [`docs/awcms-mini/README.md`](docs/awcms-mini/README.md) §Langkah berikutnya), atau perawatan/peningkatan lanjutan. Status per-issue historis dicatat di [`docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`](docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md).

## Ringkasan proyek

| Aspek             | Keputusan                                                          |
| ----------------- | ------------------------------------------------------------------ |
| Produk            | standar modular monolith berbasis AWCMS-Mini                       |
| Runtime           | Bun                                                                |
| Backend platform  | **Bun-only**; Node.js dilarang kecuali pengecualian terdokumentasi |
| Web framework     | Astro 7                                                            |
| Database          | PostgreSQL                                                         |
| Arsitektur        | Modular monolith, microservice-ready                               |
| Mode operasi      | Offline-first / LAN-first, optional online sync                    |
| Security baseline | RBAC + ABAC + PostgreSQL RLS + Audit Log                           |
| API contract      | OpenAPI                                                            |
| Event contract    | AsyncAPI                                                           |
| Bahasa dokumen    | Indonesia (teknis)                                                 |

## Alur kerja wajib setiap task

```mermaid
flowchart TD
  A[Terima issue / sprint] --> B[Baca AGENTS.md + docs terkait]
  B --> C[Baca kode, sql, openapi, asyncapi terkait]
  C --> D{Scope jelas & atomic?}
  D -- Tidak --> E[Klarifikasi / pecah issue]
  E --> C
  D -- Ya --> F[Implementasi minimal & atomic]
  F --> G{Schema berubah?}
  G -- Ya --> H[Tambah migration SQL berurutan]
  G -- Tidak --> I{API berubah?}
  H --> I
  I -- Ya --> J[Update OpenAPI]
  I -- Tidak --> K{Event berubah?}
  J --> K
  K -- Ya --> L[Update AsyncAPI]
  K -- Tidak --> M[Tulis / update test]
  L --> M
  M --> N[Jalankan validasi: migrate, spec-check, test, build]
  N --> O{Semua pass?}
  O -- Tidak --> F
  O -- Ya --> P[Update docs + laporan implementasi]
  P --> Q[Commit atomic + PR]
```

## Aturan wajib (non-negotiable)

1. **Baca dulu** README, `docs/awcms-mini/`, `package.json`, `sql/`, `src/modules/`, `openapi/`, `asyncapi/` sebelum mengedit.
2. **Atomic** — kerjakan satu issue/sprint; jangan ubah file yang tidak berkaitan.
3. **Migration** — setiap perubahan schema harus migration SQL baru yang berurutan (tidak me-rename migration lama yang sudah rilis).
4. **OpenAPI** — setiap API baru/berubah harus diperbarui di `openapi/`.
5. **AsyncAPI** — setiap domain event baru/berubah harus diperbarui di `asyncapi/`.
6. **Idempotency** — mutation high-risk wajib `Idempotency-Key` (lihat daftar di doc 05 & 10).
7. **Tenant safety** — data tenant-scoped wajib tenant context + ABAC + RLS.
8. **Audit** — high-risk action wajib audit log.
9. **Masking** — data sensitif (password, token, NPWP, NIK, phone, email, receipt token) wajib dimask/redact; jangan pernah masuk response/log/audit mentah.
10. **No secret** — jangan commit `.env`, token, dump DB, backup, atau data customer asli.
11. **Provider eksternal** (R2, WhatsApp, email, AI) **tidak boleh** jadi dependency transaksi operasional dan **tidak boleh** dipanggil di dalam DB transaction.
12. **Immutable** — dokumen/data yang sudah posted (bila aplikasi turunan memilikinya, mis. transaksi domain) bersifat append-only; koreksi lewat reversal/adjustment, bukan overwrite/delete.
13. **Soft delete** — master/config/draft tenant-scoped yang bisa dihapus wajib memakai soft delete (`deleted_at`, `deleted_by`, `delete_reason`) dengan filter default `deleted_at IS NULL`; restore/purge hanya untuk role berizin, diaudit, dan tidak berlaku untuk dokumen posted immutable.
14. **Backend Bun-only** — backend, scripts, test, migration, build, dan tooling repository wajib memakai `bun`. Dilarang menambah runtime/tooling Node.js (`node`, `npm`, `npx`, `pnpm`, `yarn`, server adapter Node.js, atau package yang memaksa runtime Node.js) kecuali Bun belum mendukung kebutuhan teknis tersebut. Pengecualian wajib mendapat izin eksplisit dari maintainer, mencatat alasan/masa berlaku/alternatif Bun yang dicoba di docs terkait, dan menambahkan entry di `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`.

## Guardrail keamanan (ringkas dari doc 10 & 13)

```mermaid
flowchart LR
  Req[Request] --> Auth[Auth middleware]
  Auth --> Tenant[Tenant context + RLS set]
  Tenant --> ABAC[ABAC guard - default deny]
  ABAC --> Valid[Input validation]
  Valid --> Idem{High-risk mutation?}
  Idem -- Ya --> Key[Idempotency-Key check]
  Idem -- Tidak --> Svc[Service + Transaction]
  Key --> Svc
  Svc --> Audit[Audit high-risk]
  Audit --> Mask[Mask sensitive - safe DTO]
  Mask --> Res[Standard response helper]
```

- **Default deny**, deny overrides allow.
- RLS tetap wajib walau ABAC sudah cek (defense in depth).
- Query list/detail default menyembunyikan soft-deleted record; akses arsip/restore/purge butuh permission eksplisit.
- Error response standard, tidak expose stack trace.
- Provider secret hanya dari environment variable.

## Skill proyek (`.claude/skills/`)

AWCMS-Mini menyediakan **skill Claude Code tingkat-proyek** yang meng-encode standar dokumen agar diterapkan konsisten. Model memanggilnya otomatis saat relevan, atau kamu panggil manual via `/<nama-skill>`. Katalog lengkap: [`.claude/skills/README.md`](.claude/skills/README.md).

| Butuh…                                                                 | Skill                              |
| ---------------------------------------------------------------------- | ---------------------------------- |
| Kerjakan issue/sprint atomic (orkestrator)                             | `awcms-mini-implement-issue`       |
| Scaffold modul baru                                                    | `awcms-mini-new-module`            |
| Kelola/konsumsi sistem Module Management (registry, lifecycle, health) | `awcms-mini-module-management`     |
| Migration SQL (tabel/index/RLS)                                        | `awcms-mini-new-migration`         |
| Endpoint REST + OpenAPI                                                | `awcms-mini-new-endpoint`          |
| Domain event + AsyncAPI                                                | `awcms-mini-new-event`             |
| Idempotency mutation high-risk                                         | `awcms-mini-idempotency`           |
| ABAC default-deny + RLS                                                | `awcms-mini-abac-guard`            |
| Audit high-risk + redaction                                            | `awcms-mini-audit-log`             |
| Correlation ID otomatis, retensi/purge log                             | `awcms-mini-observability`         |
| Masking data sensitif                                                  | `awcms-mini-sensitive-data`        |
| Sync HMAC + anti-replay                                                | `awcms-mini-sync-hmac`             |
| Review keamanan modul                                                  | `awcms-mini-security-review`       |
| Triase & perbaiki temuan CodeQL code scanning                          | `awcms-mini-codeql-triage`         |
| Review pull request                                                    | `awcms-mini-pr-review`             |
| Tulis test berlapis                                                    | `awcms-mini-testing`               |
| E2E browser sungguhan (Playwright + Bun)                               | `awcms-mini-browser-test`          |
| Preflight & go-live                                                    | `awcms-mini-production-preflight`  |
| Pilih & jalankan profil deployment (LAN-first vs registry/Coolify)     | `awcms-mini-deploy`                |
| Layar/komponen UI sesuai design system                                 | `awcms-mini-ui-screen`             |
| Form multi-step (reusable wizard pattern)                              | `awcms-mini-wizard-form`           |
| Server-side draft persistence (resume lintas sesi/perangkat)           | `awcms-mini-form-drafts`           |
| Kirim email transaksional (provider-neutral, template, outbox)         | `awcms-mini-email`                 |
| String UI `.po` gettext & konten multi-bahasa                          | `awcms-mini-i18n`                  |
| Rilis versi (Changesets, tag, CHANGELOG)                               | `awcms-mini-release`               |
| Migrasi data legacy (dry-run, backfill)                                | `awcms-mini-legacy-migration`      |
| Kerjakan bagian mana pun epic blog_content (Issue #537-#543)           | `awcms-mini-blog-content`          |
| Epic online public routing & tenant domain (Issue #556-#567)           | `awcms-mini-tenant-domain-routing` |
| Epic visitor analytics (Issue #617-#624)                               | `awcms-mini-visitor-analytics`     |
| Epic news_portal full-online R2-only media (Issue #631-#642, #649)     | `awcms-mini-news-portal`           |

**Peningkatan (audit & hardening artefak yang sudah ada):**

| Butuh…                                | Skill                           |
| ------------------------------------- | ------------------------------- |
| Audit & naikkan mutu UI/UX yang ada   | `awcms-mini-ux-review`          |
| Tuning performa aplikasi & database   | `awcms-mini-performance`        |
| Kerasan backend & integrasi eksternal | `awcms-mini-integration`        |
| Audit keamanan OWASP/ASVS/ISO         | `awcms-mini-security-hardening` |

**Maintenance/tooling (jaga artefak mekanis tetap sinkron):**

| Butuh…                                               | Skill                        |
| ---------------------------------------------------- | ---------------------------- |
| Refresh snapshot docs GitHub (issue/label/milestone) | `awcms-mini-github-snapshot` |

```mermaid
flowchart LR
  II[awcms-mini-implement-issue] --> NM[new-module]
  II --> MIG[new-migration]
  II --> EP[new-endpoint]
  II --> EV[new-event]
  II --> TST[testing]
  EP --> ABAC[abac-guard]
  EP --> IDEM[idempotency]
  ABAC --> AUD[audit-log]
  AUD --> OBS[observability]
  EP --> SD[sensitive-data]
  EV --> SYNC[sync-hmac]
  II --> PR[pr-review] --> SEC[security-review] --> PF[production-preflight]
  PF --> DEP[deploy]
  UI2[ui-screen] --> UXR[ux-review]
  UI2 --> I18N[i18n]
  UI2 --> WIZ[wizard-form]
  WIZ --> IDEM
  WIZ --> DRAFT[form-drafts]
  DRAFT --> IDEM
  EP --> PERF[performance]
  EP --> INT[integration]
  SEC --> HARD[security-hardening]
  EP --> EMAIL[email]
  EMAIL --> INT
  EMAIL --> SD
  II --> BLOG[blog-content]
  BLOG --> EP
  BLOG --> MIG
  II --> VA[visitor-analytics]
  VA --> MIG
  VA --> NM
  VA --> EP
  VA --> UI2
  VA --> SD
  II --> NP[news-portal]
  NP --> MIG
  NP --> EP
  NP --> UI2
  NP --> SD
  NP --> INT
  NP --> IDEM
```

Skill merujuk `docs/awcms-mini/*` sebagai sumber kebenaran; bila standar berubah, perbarui doc **dan** skill terkait.

## Subagents (`.claude/agents/`)

Untuk delegasi kerja penuh, tersedia subagent yang memetakan prompt di doc 12:

| Agent                         | Peran                                  | Prompt asal (doc 12)     | Tools     |
| ----------------------------- | -------------------------------------- | ------------------------ | --------- |
| `awcms-mini-coder`            | Implementasi issue end-to-end          | Prompt Induk / Per Issue | Semua     |
| `awcms-mini-reviewer`         | Review PR/diff terhadap DoD            | Prompt Review PR         | Read-only |
| `awcms-mini-security-auditor` | Audit keamanan modul + verdict go-live | Prompt Security Review   | Read-only |

```mermaid
flowchart LR
  Issue[GitHub issue] --> C[awcms-mini-coder<br/>implementasi + laporan]
  C --> R[awcms-mini-reviewer<br/>verdict + temuan]
  R -->|modul sensitif| S[awcms-mini-security-auditor<br/>PASS / BLOCKED]
  R -->|approve| M[Merge]
  S -->|PASS| M
  S -->|BLOCKED| C
```

Aturan: reviewer & auditor **read-only** (temuan dikembalikan ke coder); auditor memberi verdict go-live — critical finding = BLOCKED (gate doc 07).

## Perintah yang sudah tersedia sekarang

Base generik selesai (v0.23.5) — semua skrip di bawah ini nyata dan
berjalan, bukan target/rencana:

```bash
bun install
bun run check                    # gate lengkap: lint + check:docs + api:spec:check + modules:dag:check + i18n:parity:check + config:docs:check + typecheck + test + build
bun run dev                      # bun --bun astro dev
bun run build                    # bun --bun astro build
bun run preview                  # bun --bun astro preview
bun run start                    # bun ./dist/server/entry.mjs (SSR di atas Bun)
bun run db:migrate               # Bun.SQL PostgreSQL migration runner
bun run api:spec:check           # validasi OpenAPI/AsyncAPI baseline
bun run lint                     # prettier --check
bun run format                   # prettier --write
bun run check:docs               # validasi mermaid, tautan internal, penamaan
bun run typecheck                # tsc --noEmit
bun test                         # unit + integration test (bun:test) di tests/
bun run test:coverage            # bun test --coverage
bun run changeset                # tambah changeset (versioning)
bun run changeset:version        # konsumsi changeset -> bump versi + CHANGELOG
bun run changeset:status         # cek changeset pending
bun run changeset:tag            # tag rilis dari changeset
bun run db:pool:health           # cek kesehatan pool DB
bun run security:readiness       # cek security readiness
bun run config:validate          # validasi env/config sebelum apapun jalan
bun run config:docs:check        # validasi src/lib/config/registry.ts <-> .env.example <-> doc 18 sinkron (bagian dari `bun run check`, Issue #689)
bun run production:preflight     # preflight read-only sebelum go-live (config -> security -> connectivity -> spec -> test -> build -> pool -> migration:plan); apply migrasi terpisah & bergerbang (--apply-migrations --backup-verified --acknowledge-target=<APP_ENV>, Issue #684)
bun run email:provider:health    # cek kesehatan provider email (Mailketing)
bun run sync:objects:dispatch    # job terjadwal: dispatch antrian sync object R2
bun run logs:audit:purge         # job terjadwal: purge audit log kedaluwarsa
bun run email:dispatch           # job terjadwal: dispatch outbox email
bun run email:templates:seed-defaults # seed template email default
bun run form-drafts:purge        # job terjadwal: purge form draft kedaluwarsa
bun run blog:publish:scheduled   # job terjadwal: publish blog post scheduled yang sudah due
bun run analytics:rollup         # job terjadwal: rollup visitor analytics harian per tenant/area
bun run analytics:purge          # job terjadwal: purge/anonymisasi visitor analytics kedaluwarsa
bun run modules:sync             # sinkronisasi descriptor modul ke awcms_mini_modules
bun run modules:dag:check        # validasi seluruh registry adalah DAG valid (bagian dari `bun run check`)
bun run i18n:parity:check        # validasi key en.po/id.po/messages.pot sinkron (bagian dari `bun run check`, Issue #685)
bun run github:snapshot:refresh  # refresh docs/awcms-mini/github/ dari state GitHub live
```

Tooling saat ini (`scripts/`) sudah punya unit test di `tests/`; tambahkan test
untuk setiap kode baru sesuai doc 07 §Testing Strategy dan doc 10.

**Belum diimplementasikan** (bukan di `package.json`/`scripts/`, jangan
jalankan/sarankan sebagai perintah nyata): `api:contract:test` (live
contract test terhadap server berjalan, dibedakan dari `api:spec:check`
yang hanya memvalidasi bentuk file spec OpenAPI/AsyncAPI itu sendiri).
Kalau issue butuh ini, buat `scripts/api-contract-test.ts` + entry
`package.json` baru sebagai bagian dari issue itu, jangan berasumsi sudah
ada.

## Struktur repository (target)

```text
awcms-mini/
├── AGENTS.md                # file ini
├── CHANGELOG.md             # versioning (Changesets)
├── .changeset/              # config + changeset entries
├── .claude/skills/          # 33 skill proyek (implement-issue, new-migration, dst.)
├── .claude/agents/          # subagents (coder, reviewer, security-auditor)
├── README.md
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── .env.example
├── .gitignore
├── docker-compose.yml
├── src/
│   ├── lib/                 # db, logging, auth, files, errors, i18n
│   ├── modules/             # modular monolith (lihat daftar modul)
│   └── pages/               # api/v1, admin
├── sql/                     # migration NNN_awcms_mini_<area>_<desc>.sql
├── scripts/                 # db-migrate, api-spec-check, dst.
├── openapi/                 # kontrak REST
├── asyncapi/                # kontrak event
├── docs/awcms-mini/         # paket dokumen 01–20
├── docs/adr/                # architecture decision records
├── deploy/                  # systemd, nginx, pgbouncer, backup
├── tests/
└── fixtures/
```

## Peta modul

`_shared`, `tenant-admin`, `identity-access`, `profile-identity`, `sync-storage`, `localization-ui`, `observability-logging`, `database-connectivity`, `workflow-approval`, `management-reporting`, `ui-experience`, `production-security-readiness`.

Ini adalah modul **base generik** milik AWCMS-Mini sendiri. Modul domain (mis. katalog produk, POS, gudang, pajak, CRM, AI analyst) pada umumnya **bukan bagian repo ini** — itu ditambahkan di aplikasi turunan contoh (mis. AWPOS) di atas base ini; lihat `docs/awcms-mini/README.md` §Reusable vs domain turunan.

**Pengecualian:** `blog-content` (`src/modules/blog-content`, key `blog_content`) adalah modul domain pertama yang didaftarkan **langsung** di repo base ini (epic #536, Issue #537 dst., `docs/adr/0009-public-tenant-scoped-routes.md`) — bukan di aplikasi turunan terpisah. Perlakukan sebagai contoh referensi domain module di atas base, bukan preseden untuk memindahkan modul domain lain (POS, gudang, dst.) ke repo ini.

Struktur tiap modul: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/`, `README.md`.

## Urutan implementasi (jangan dilompati)

```mermaid
flowchart LR
  F[Foundation 0.1-0.3] --> S[Setup Wizard 12.1]
  S --> T[Tenant/Office 2.1]
  T --> P[Profile 2.2]
  P --> A[Identity 2.3]
  A --> R[RBAC/ABAC 2.4]
  R --> OBS[Logging/Pooling/Security 10.1-10.3]
  OBS --> SY[Sync Storage 6.1-6.3]
  SY --> UI[UI Shell/Reporting 8.1 . 9.1]
  UI --> WF[Workflow Approval 11.1]
  WF --> DEP[Deployment 12.2]
```

Alasan urutan: aplikasi turunan tidak aman tanpa tenant/auth/profile/access; observability/pooling/security readiness disiapkan sebelum modul lain bergantung padanya; provider eksternal (sync/R2) menyusul; production diaktifkan hanya setelah security readiness pass.

## Konvensi commit

```text
<type>(<scope>): <summary>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `security`, `perf`, `ci`, `build`.
Scopes: `foundation`, `db`, `api`, `auth`, `access`, `profile`, `tenant`, `sync`, `ui`, `logging`, `pooling`, `workflow`, `reporting`, `security`, `docs`. Aplikasi turunan menambah scope domainnya sendiri (mis. `pos`, `inventory`, `warehouse`, `tax`, `crm`).

Branch: `feature/<issue>-<name>`, `fix/<issue>-<name>`, `release/vX.Y.Z`, `hotfix/vX.Y.Z-<name>`.

## Definition of Done

- Scope sesuai issue, tidak ada unrelated change.
- Migration jika schema berubah; OpenAPI jika API berubah; AsyncAPI jika event berubah.
- Input validation, Auth/ABAC/RLS, audit high-risk, sensitive masking.
- Soft delete diterapkan untuk resource yang deletable; dokumen posted tetap immutable dan tidak di-soft-delete.
- Test relevan pass; build pass.
- Docs diperbarui.
- **Changeset** ditambahkan (`bun run changeset`) bila perubahan mempengaruhi perilaku; docs-only/chore boleh tanpa.
- Laporan implementasi disertakan.

## Template laporan implementasi

```text
Summary:
Files changed:
Commands run:
Test results:
Security notes:
Documentation updates:
Remaining limitations:
Next recommended step:
```

## Peta dokumen (baca sesuai kebutuhan task)

| Butuh memahami…                                                    | Baca                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Arsitektur & fase                                                  | `docs/awcms-mini/01_canvas_induk.md`                        |
| Kebutuhan produk                                                   | `docs/awcms-mini/02_prd_detail_per_modul.md`                |
| Spesifikasi teknis                                                 | `docs/awcms-mini/03_srs_detail_per_modul.md`                |
| Database/ERD/RLS                                                   | `docs/awcms-mini/04_erd_data_dictionary.md`                 |
| Kontrak API/event                                                  | `docs/awcms-mini/05_openapi_asyncapi_detail.md`             |
| Issue atomic                                                       | `docs/awcms-mini/06_github_issues_detail.md`                |
| Sprint/testing/go-live                                             | `docs/awcms-mini/07_sprint_testing_production_readiness.md` |
| SOP operasional                                                    | `docs/awcms-mini/08_sop_operasional_user_guide.md`          |
| Roadmap repo/commit                                                | `docs/awcms-mini/09_roadmap_repository_commit.md`           |
| Coding standard                                                    | `docs/awcms-mini/10_template_kode_coding_standard.md`       |
| Blueprint skeleton                                                 | `docs/awcms-mini/11_implementation_blueprint.md`            |
| Prompt eksekusi                                                    | `docs/awcms-mini/12_generator_prompt.md`                    |
| Master index/traceability                                          | `docs/awcms-mini/13_final_master_index_traceability.md`     |
| UI/UX, design token, layar                                         | `docs/awcms-mini/14_ui_ux_design_system.md`                 |
| Frontend & integrasi, offline-first                                | `docs/awcms-mini/15_frontend_architecture_integration.md`   |
| Data access, pooling, RLS, outbox                                  | `docs/awcms-mini/16_backend_data_access_integration.md`     |
| Role default, permission, ABAC seed                                | `docs/awcms-mini/17_default_seed_rbac_abac.md`              |
| Env, feature flag, deployment                                      | `docs/awcms-mini/18_configuration_env_reference.md`         |
| Glossary & terminologi                                             | `docs/awcms-mini/19_glossary_terminology.md`                |
| Threat model & arsitektur keamanan                                 | `docs/awcms-mini/20_threat_model_security_architecture.md`  |
| Keputusan arsitektural (ADR)                                       | `docs/adr/README.md`                                        |
| Tata kelola, kontribusi, keamanan repo                             | `GOVERNANCE.md`, `CONTRIBUTING.md`, `SECURITY.md`           |
| Snapshot GitHub issue aktual, label, milestone, dan proses refresh | `docs/awcms-mini/github/README.md`                          |

## Mulai dari sini

Base generik sudah selesai (v0.23.5, lihat blockquote status di atas) — tidak ada lagi "Issue 0.1" untuk dikerjakan sebagai pekerjaan baru. Untuk kontribusi baru:

- **Membangun aplikasi turunan / modul domain** (AWPOS, portal, sistem pengaduan, dsb.) di atas base ini → mulai dengan skill `awcms-mini-new-module`, lalu `awcms-mini-new-migration` → `awcms-mini-new-endpoint` → `awcms-mini-new-event` → `awcms-mini-testing` → `awcms-mini-security-review` → `awcms-mini-production-preflight`. Orkestrasi penuh: skill `awcms-mini-implement-issue`. Lihat panduan lengkap di [`docs/awcms-mini/README.md`](docs/awcms-mini/README.md) §Langkah berikutnya.
- **Perawatan / peningkatan base** (performa, UX, integrasi, keamanan, observability) → pakai skill peningkatan terkait (`awcms-mini-performance`, `awcms-mini-ux-review`, `awcms-mini-integration`, `awcms-mini-security-hardening`, `awcms-mini-observability`) dan catat di §Perawatan pasca-backlog pada `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`.

Pertahankan lapisan reusable base; ganti/ tambah hanya lapisan spesifik domain. Doc 09 dan doc 12 tetap acuan konvensi commit/roadmap/generator, bukan urutan pengerjaan issue foundation yang sudah selesai.
