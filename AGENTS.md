# AGENTS.md — Panduan Agent & Kontributor AWCMS-Mini

Dokumen ini adalah **kontrak kerja** untuk coding agent (Claude Code, Codex, dsb.) maupun developer manusia yang mengimplementasikan AWCMS-Mini. Setiap sesi implementasi **wajib membaca file ini terlebih dahulu**, lalu dokumen terkait di `docs/awcms-mini/`.

> **Konteks keluarga produk:** kontrak repository ini (AGENTS.md, README.md, CONTRIBUTING.md, `derived-application-guide.md`, dan skill proyek) menjadi **sumber utama** bagi [`docs/Pedoman_Penggunaan_Agent_Keluarga_AWCMS_v1.0.pdf`](docs/Pedoman_Penggunaan_Agent_Keluarga_AWCMS_v1.0.pdf) — pedoman penggunaan agent yang berlaku lintas keluarga produk (AWCMS, AWCMS-Mini, AWCMS-Micro, dan software turunannya). Bila ada perbedaan, dokumen repository ini (AGENTS.md, ADR, kontrak) tetap sumber kebenaran paling spesifik untuk repo ini.

> **Status base generik: selesai (v0.23.5).** Seluruh 18 issue backlog base generik (doc 06) tuntas — foundation, tenant/office, central profile, identity/login, RBAC/ABAC, setup wizard, Sync Storage (outbox/inbox/conflict/object-queue), management reporting, structured logging & audit trail, connection pooling & backpressure, production readiness, workflow approval, dan deployment profile — plus perawatan/peningkatan pasca-backlog milestone M9 (penegakan RLS + role least-privilege, Access & Users / Sync / Settings admin, runtime i18n, audit UX/UI & aksesibilitas AA, audit performa, dispatcher object-sync + kerasan integrasi, security hardening OWASP/ASVS/ISO, dan aktivasi sistem log). Tabel tenant/auth/RBAC/sync/logging/deployment **sudah** ada dan berjalan — jangan membangunnya ulang. Pekerjaan baru = **aplikasi turunan / modul domain** di atas base ini (lihat [`docs/awcms-mini/README.md`](docs/awcms-mini/README.md) §Langkah berikutnya), atau perawatan/peningkatan lanjutan. Status per-issue historis dicatat di [`docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md`](docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md).

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
4. **OpenAPI** — setiap API baru/berubah harus diperbarui di `openapi/`. Sejak Issue #695, `openapi/awcms-mini-public-api.openapi.yaml` adalah artefak GENERATED (jangan edit langsung) — edit fragment sumber (`openapi/awcms-mini-public-api.src.yaml` + `openapi/modules/*.yaml`), jalankan `bun run openapi:bundle`, lalu commit fragment DAN hasil bundle bersamaan; lihat `openapi/README.md`.
5. **AsyncAPI** — setiap domain event baru/berubah harus diperbarui di `asyncapi/`.
6. **Idempotency** — mutation high-risk wajib `Idempotency-Key` (lihat daftar di doc 05 & 10).
7. **Tenant safety** — data tenant-scoped wajib tenant context + ABAC + RLS.
8. **Audit** — high-risk action wajib audit log.
9. **Masking** — data sensitif (password, token, NPWP, NIK, phone, email, receipt token) wajib dimask/redact; jangan pernah masuk response/log/audit mentah.
10. **No secret** — jangan commit `.env`, token, dump DB, backup, atau data customer asli.
11. **Provider eksternal** (R2, WhatsApp, email, AI) **tidak boleh** jadi dependency transaksi operasional dan **tidak boleh** dipanggil di dalam DB transaction.
12. **Immutable** — dokumen/data yang sudah posted (bila aplikasi turunan memilikinya, mis. transaksi domain) bersifat append-only; koreksi lewat reversal/adjustment, bukan overwrite/delete.
13. **Soft delete** — master/config/draft tenant-scoped yang bisa dihapus wajib memakai soft delete (`deleted_at`, `deleted_by`, `delete_reason`) dengan filter default `deleted_at IS NULL`; restore/purge hanya untuk role berizin, diaudit, dan tidak berlaku untuk dokumen posted immutable.
14. **Backend Bun-only** — backend, scripts, test, migration, build, dan tooling repository wajib memakai `bun`. Dilarang menambah runtime/tooling Node.js (`node`, `npm`, `npx`, `pnpm`, `yarn`, server adapter Node.js, atau package yang memaksa runtime Node.js) kecuali Bun belum mendukung kebutuhan teknis tersebut. Pengecualian wajib mendapat izin eksplisit dari maintainer, mencatat alasan/masa berlaku/alternatif Bun yang dicoba di docs terkait, dan menambahkan entry di `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md`.
15. **Dokumen audit = dokumen hidup, nama file mengikuti tanggal perubahan** — `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_<YYYY-MM-DD>.md` **tidak boleh ditumpuk sebagai file baru**. Setiap kali isinya diperbarui: `git mv` ke tanggal perubahan terbaru, perbarui isinya, lalu **perbarui seluruh rujukan nama file** di repo (`grep -rl "AUDIT_STANDAR_PENGEMBANGAN" --include="*.md" . | grep -v node_modules`) — saat ini dirujuk dari `README.md`, `AGENTS.md` (aturan 14 + §Peta kerja), `docs/ARCHITECTURE.md`, `docs/awcms-mini/README.md`, doc 06/09/10/15/18, `derived-app-pilot-plan.md`, `production-readiness.md`, `github/README.md`, `github/issues-closed-001.md`, `src/modules/email/README.md`, dan skill `awcms-mini-browser-test`. **Kecualikan `CHANGELOG.md`**: entri lama merujuk nama file pada saat itu dan akurat secara historis — jangan diubah (lih. skill `awcms-mini-release` §Aturan). Pertahankan §Riwayat rename di dalam dokumen.

16. **Memory agent wajib disnapshot ke docs** — memory Claude Code hidup di `~/.claude/projects/<slug-cwd>/memory/`, **di luar repo**, jadi tidak ikut `git clone` dan hilang saat pindah device. **Setiap kali menulis/mengubah/menghapus memory, jalankan `bun run memory:docs:sync`** sebelum commit; `docs/awcms-mini/agent-memory.md` harus sinkron dengan memory aktif (`bun run memory:docs:check` gagal bila melenceng, dan skip bila device tak punya memory). Device/checkout baru: `bun run memory:docs:restore`. **Sumber kebenaran = memory aktif**, bukan snapshot. Repo ini **publik** — jangan pernah menulis secret nyata ke memory; snapshot menyanitasi `originSessionId`/homedir/placeholder-password dan mengecualikan memory device-specific (lihat §Sengaja TIDAK disertakan di dokumen itu).

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

| Butuh…                                                                                                                                             | Skill                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Kerjakan issue/sprint atomic (orkestrator)                                                                                                         | `awcms-mini-implement-issue`         |
| Scaffold modul baru                                                                                                                                | `awcms-mini-new-module`              |
| Kelola/konsumsi sistem Module Management (registry, lifecycle, health)                                                                             | `awcms-mini-module-management`       |
| Migration SQL (tabel/index/RLS)                                                                                                                    | `awcms-mini-new-migration`           |
| Endpoint REST + OpenAPI                                                                                                                            | `awcms-mini-new-endpoint`            |
| Domain event + AsyncAPI                                                                                                                            | `awcms-mini-new-event`               |
| Idempotency mutation high-risk                                                                                                                     | `awcms-mini-idempotency`             |
| ABAC default-deny + RLS                                                                                                                            | `awcms-mini-abac-guard`              |
| Audit high-risk + redaction                                                                                                                        | `awcms-mini-audit-log`               |
| Correlation ID otomatis, retensi/purge log, metrics port                                                                                           | `awcms-mini-observability`           |
| Masking data sensitif                                                                                                                              | `awcms-mini-sensitive-data`          |
| Sync HMAC + anti-replay                                                                                                                            | `awcms-mini-sync-hmac`               |
| Review keamanan modul                                                                                                                              | `awcms-mini-security-review`         |
| Triase & perbaiki temuan CodeQL code scanning                                                                                                      | `awcms-mini-codeql-triage`           |
| Review pull request                                                                                                                                | `awcms-mini-pr-review`               |
| Tulis test berlapis                                                                                                                                | `awcms-mini-testing`                 |
| E2E browser sungguhan (Playwright + Bun)                                                                                                           | `awcms-mini-browser-test`            |
| Preflight & go-live                                                                                                                                | `awcms-mini-production-preflight`    |
| Pilih & jalankan profil deployment (LAN-first vs registry/Coolify)                                                                                 | `awcms-mini-deploy`                  |
| Layar/komponen UI sesuai design system                                                                                                             | `awcms-mini-ui-screen`               |
| Form multi-step (reusable wizard pattern)                                                                                                          | `awcms-mini-wizard-form`             |
| Server-side draft persistence (resume lintas sesi/perangkat)                                                                                       | `awcms-mini-form-drafts`             |
| Kirim email transaksional (provider-neutral, template, outbox)                                                                                     | `awcms-mini-email`                   |
| String UI `.po` gettext & konten multi-bahasa                                                                                                      | `awcms-mini-i18n`                    |
| Rilis versi (Changesets, tag, CHANGELOG)                                                                                                           | `awcms-mini-release`                 |
| Migrasi data legacy (dry-run, backfill)                                                                                                            | `awcms-mini-legacy-migration`        |
| Kerjakan bagian mana pun epic blog_content (Issue #537-#543)                                                                                       | `awcms-mini-blog-content`            |
| Epic online public routing & tenant domain (Issue #556-#567)                                                                                       | `awcms-mini-tenant-domain-routing`   |
| Epic full-online auth security hardening (Issue #587-#593)                                                                                         | `awcms-mini-auth-online-hardening`   |
| Epic visitor analytics (Issue #617-#624)                                                                                                           | `awcms-mini-visitor-analytics`       |
| Epic news_portal full-online R2-only media (Issue #631-#642, #649)                                                                                 | `awcms-mini-news-portal`             |
| Epic master data wilayah administratif Indonesia (Issue #655-#664)                                                                                 | `awcms-mini-idn-admin-regions`       |
| Epic social_publishing auto-posting outbox foundation (Issue #643-#647)                                                                            | `awcms-mini-social-publishing`       |
| Registry retensi/partisi/arsip/legal hold/purge tabel bervolume tinggi (Issue #745)                                                                | `awcms-mini-data-lifecycle`          |
| Kontrak kesiapan ekstensi ERP (business transaction/posting/period-lock/item/reporting-projection, Issue #755)                                     | `awcms-mini-erp-extension-readiness` |
| Modul document_infrastructure — registry dokumen generik, versioning, numbering (Issue #751)                                                       | `awcms-mini-document-infrastructure` |
| Modul integration_hub — inbound webhook, outbound subscription, adapter, SSRF guard (Issue #754)                                                   | `awcms-mini-integration-hub`         |
| Modul workflow_approval — graph engine, delegation/escalation/quorum (Issue 11.1, evolved #747)                                                    | `awcms-mini-workflow-approval`       |
| Modul profile_identity — party CRUD, merge workflow, cross-tenant guard (Issue 2.2, dilengkapi #748)                                               | `awcms-mini-profile-identity`        |
| Modul data_exchange — import/export staged CSV/JSON, formula injection, masking `sensitiveFields` (Issue #752)                                     | `awcms-mini-data-exchange`           |
| Modul reference_data — value set, tenant override, import tervalidasi, PATCH parsial (Issue #750)                                                  | `awcms-mini-reference-data`          |
| Modul service_catalog — plan/offer SaaS berversi, control-plane default-disabled, offer immutable (Issue #870)                                     | `awcms-mini-service-catalog`         |
| Modul tenant_entitlement — entitlement efektif fitur/modul/kuota, kontrak fail-closed effective_entitlement, tenant-scoped RLS FORCE (Issue #871)  | `awcms-mini-tenant-entitlement`      |
| Registry kontrak SaaS build-time (feature/quota/meter/commercial-event) single source of truth, gate konformans, versioning (Issue #874)           | `awcms-mini-saas-contracts`          |
| Modul usage_metering — event append-only numeric-only, aggregation deterministik, koreksi bertanda, quota fail-closed, reconciliation (Issue #875) | `awcms-mini-usage-metering`          |
| Modul domain_event_runtime — outbox transaksional, consumer registry, ordering, replay (Issue #742)                                                | `awcms-mini-domain-event-runtime`    |
| Modul organization_structure — legal entity, hierarki unit effective-dated, business scope port (Issue #749)                                       | `awcms-mini-organization-structure`  |
| Modul reporting — lima view live + projections/freshness/rebuild/scheduled export (Issue 9.1, #753)                                                | `awcms-mini-reporting`               |

**Peningkatan (audit & hardening artefak yang sudah ada):**

| Butuh…                                | Skill                           |
| ------------------------------------- | ------------------------------- |
| Audit & naikkan mutu UI/UX yang ada   | `awcms-mini-ux-review`          |
| Tuning performa aplikasi & database   | `awcms-mini-performance`        |
| Kerasan backend & integrasi eksternal | `awcms-mini-integration`        |
| Audit keamanan OWASP/ASVS/ISO         | `awcms-mini-security-hardening` |

**Maintenance/tooling (jaga artefak mekanis tetap sinkron):**

| Butuh…                                                    | Skill                        |
| --------------------------------------------------------- | ---------------------------- |
| Refresh snapshot docs GitHub (issue/label/milestone)      | `awcms-mini-github-snapshot` |
| Regenerate inventori modul/migration/tabel-RLS/test/route | `awcms-mini-repo-inventory`  |

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
  II --> AOH[auth-online-hardening]
  AOH --> MIG
  AOH --> EP
  AOH --> IDEM
  AOH --> ABAC
  AOH --> AUD
  AOH --> SD
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
  II --> IDN[idn-admin-regions]
  IDN --> NM
  IDN --> MIG
  IDN --> EP
  IDN --> UI2
  IDN --> ABAC
  IDN --> AUD
  II --> SP[social-publishing]
  SP --> MIG
  SP --> EP
  SP --> UI2
  SP --> ABAC
  SP --> AUD
  SP --> IDEM
  SP --> INT
  II --> DL[data-lifecycle]
  DL --> MIG
  DL --> NM
  DL --> EP
  DL --> ABAC
  DL --> AUD
  DL --> IDEM
  II --> ERPX[erp-extension-readiness]
  ERPX --> IDEM
  ERPX --> EV
  II --> DOCI[document-infrastructure]
  DOCI --> MIG
  DOCI --> EP
  DOCI --> ABAC
  DOCI --> AUD
  DOCI --> IDEM
  II --> IH[integration-hub]
  IH --> MIG
  IH --> EP
  IH --> ABAC
  IH --> AUD
  IH --> INT
  II --> WF[workflow-approval]
  WF --> MIG
  WF --> EP
  WF --> ABAC
  WF --> AUD
  WF --> IDEM
  WF --> EV
  II --> PI[profile-identity]
  PI --> MIG
  PI --> EP
  PI --> ABAC
  PI --> AUD
  PI --> SD
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
bun run check                    # gate lengkap: lint + check:docs + api:spec:check + api:docs:check + repo:inventory:check + modules:dag:check + modules:compose:check + modules:composition:inventory:check + extension:check + data-lifecycle:registry:check + reporting:projections:registry:check + identity-access:sod-registry:check + reference-data:contributions:check + i18n:pot:check + i18n:parity:check + config:docs:check + logging:lint:check + tx:lint:check + db:work-class:check + typecheck + test + build
bun run dev                      # bun --bun astro dev
bun run build                    # bun --bun astro build
bun run preview                  # bun --bun astro preview
bun run start                    # bun ./dist/server/entry.mjs (SSR di atas Bun)
bun run db:migrate               # Bun.SQL PostgreSQL migration runner
bun run api:spec:check           # validasi OpenAPI/AsyncAPI baseline (route parity, operationId unik, path parameter, standard error schema, security metadata, bundle freshness)
bun run openapi:bundle           # generate openapi/awcms-mini-public-api.openapi.yaml dari fragment openapi/awcms-mini-public-api.src.yaml + openapi/modules/*.yaml (Issue #695) — jalankan sebelum commit tiap kali fragment sumber berubah
bun run api:docs:generate        # generate docs/awcms-mini/api-reference.md (referensi API & event manusiawi) dari kontrak OpenAPI/AsyncAPI ter-bundle (Issue #700) — jalankan sebelum commit tiap kali kontrak ter-bundle berubah
bun run api:docs:check           # validasi docs/awcms-mini/api-reference.md tidak stale relatif kontrak ter-bundle (read-only, bagian dari `bun run check`, Issue #700)
bun run repo:inventory:generate  # generate docs/awcms-mini/repo-inventory.md (modul, migration, tabel/RLS, test) dari registry/sql/tests/kontrak ter-bundle (Issue #688, epic #679) — jalankan sebelum commit tiap kali modul/migration/test/route berubah
bun run repo:inventory:check     # validasi docs/awcms-mini/repo-inventory.md tidak stale relatif regenerasi (read-only, bagian dari `bun run check`, Issue #688)
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
bun run logging:lint:check       # gate: larang console.error/warn dengan raw error/error.message/error.stack tanpa sanitasi di src/pages/admin, src/pages/api/v1, scripts/ (bagian dari `bun run check`, Issue #687)
bun run tx:lint:check            # gate: larang Promise.all/allSettled di atas transaction handle (`tx`) — query konkuren di atas SATU koneksi Postgres MENGHANG; konkurensi di atas POOL (`sql`) tetap legal (bagian dari `bun run check`, Issue #842)
bun run production:preflight     # preflight read-only sebelum go-live (config -> security -> connectivity -> spec -> test -> build -> pool -> migration:plan); apply migrasi terpisah & bergerbang (--apply-migrations --backup-verified --acknowledge-target=<APP_ENV>, Issue #684)
bun run resilience:dr-drill      # failure-injection & DR verification (safety interlock default-deny target produksi; tier safe default, --full menambah restore-drill.sh; Issue #699)
bun run performance:suite        # performance suite representatif: seed fixture sintetik + skenario load/soak/saturasi-recovery (safety interlock sama dengan dr-drill; tier safe default, --full menambah skala large + soak-stability; Issue #744)
bun run performance:query-plan:check # budget regresi query-plan versioned (RLS/pagination, search, outbox-claim, retention-purge, reporting) terhadap fixture skala safe (Issue #744)
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
bun run modules:compose:check    # validasi registry base + application-registry.ts terkomposisi valid (bagian dari `bun run check`, Issue #740)
bun run modules:composition:inventory:generate # generate docs/awcms-mini/module-composition-inventory.json dari registry terkomposisi (Issue #740) — jalankan sebelum commit tiap kali registry/capability/migration-namespace berubah
bun run modules:composition:inventory:check    # validasi module-composition-inventory.json tidak stale (read-only, bagian dari `bun run check`, Issue #740)
bun run extension:check          # validasi extension.manifest.json (bila ada) + komposisi registry — jalan identik di repo base ini & repo turunan (bagian dari `bun run check`, `ci.yml`, dan `production:preflight`, Issue #741/ADR-0015)
bun run domain-events:dispatch   # job terjadwal: claim/eksekusi/finalize domain event deliveries (outbox generik multi-consumer, Issue #742)
bun run i18n:extract             # generate ulang i18n/messages.pot dari scan t("...") di src/ (mutasi file, TIDAK di `bun run check` — Issue #694)
bun run i18n:pot:check           # validasi i18n/messages.pot identik dengan hasil i18n:extract (read-only, bagian dari `bun run check`, Issue #694)
bun run i18n:parity:check        # validasi key + placeholder en.po/id.po/messages.pot sinkron, plus guard msgid_plural belum didukung (bagian dari `bun run check`, Issue #685/#694)
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
├── .claude/skills/          # 45 skill proyek (implement-issue, new-migration, dst.)
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
├── openapi/                 # kontrak REST (src.yaml + modules/*.yaml = sumber; awcms-mini-public-api.openapi.yaml = bundle GENERATED, Issue #695)
├── asyncapi/                # kontrak event
├── docs/awcms-mini/         # paket dokumen 01–20
├── docs/adr/                # architecture decision records
├── deploy/                  # systemd, nginx, pgbouncer, backup
├── tests/
└── fixtures/
```

## Peta modul

Modul **base generik** yang terdaftar di registry (`src/modules/index.ts` `listModules()`, lihat juga inventori GENERATED `docs/awcms-mini/repo-inventory.md` §Modules untuk daftar hidup key/versi/status):

`tenant-admin` (`tenant_admin`), `profile-identity` (`profile_identity`), `identity-access` (`identity_access`), `sync-storage` (`sync_storage`), `reporting` (`reporting`), `logging` (`logging`), `workflow-approval` (`workflow`), `form-drafts` (`form_drafts`), `email` (`email`), `module-management` (`module_management`), `idn-admin-regions` (`idn_admin_regions`, `type: base`, `status: experimental` — epic #654 master data wilayah administratif Indonesia, Issue #655-#664, lihat `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`), `domain-event-runtime` (`domain_event_runtime`, `type: system` — epic `platform-evolution` #738 Wave 1, Issue #742, transactional multi-consumer domain-event outbox/dispatcher, lihat `src/modules/domain-event-runtime/README.md`), `organization-structure` (`organization_structure`, `type: domain` — epic `platform-evolution` #738 Wave 2, Issue #749, ADR-0016, hierarki organisasi/business-scope lintas modul, lihat `src/modules/organization-structure/README.md`), `document-infrastructure` (`document_infrastructure`, `type: domain` — epic `platform-evolution` #738 Wave 3, Issue #751, ADR-0017, capability port `document_resource_relations` reusable lintas modul, lihat `src/modules/document-infrastructure/README.md`), `data-exchange` (`data_exchange`, `type: domain` — epic `platform-evolution` #738 Wave 3, Issue #752, ADR-0018, import/export/rekonsiliasi data batch, lihat `src/modules/data-exchange/README.md`), `integration-hub` (`integration_hub`, `type: system` — epic `platform-evolution` #738 Wave 3, Issue #754, ADR-0019, gateway integrasi outbound/inbound ke provider eksternal, lihat `src/modules/integration-hub/README.md`), `reference-data` (`reference_data`, `type: domain` — epic `platform-evolution` #738 Wave 3, Issue #750, ADR-0021, registry data referensi lintas modul, lihat `src/modules/reference-data/README.md`).

`_shared` (`src/modules/_shared`) bukan modul terdaftar — berisi kontrak/tipe bersama (`module-contract.ts`, dsb.) yang dipakai seluruh modul lain.

Sejumlah concern lintas-modul (i18n/localization, observability wiring, database pooling, komponen UI, production/security readiness) **tidak** punya direktori `src/modules/` sendiri — mereka hidup di `src/lib/` (`i18n/`, `observability/`, `database/`, `security/`, dst.), `src/components/ui/`, dan `scripts/` (mis. `security-readiness.ts`, `production-preflight.ts`). Jangan cari/tambahkan direktori modul untuk concern ini; ikuti struktur yang sudah ada.

Modul domain (mis. katalog produk, POS, gudang, pajak, CRM, AI analyst) pada umumnya **bukan bagian repo ini** — itu ditambahkan di aplikasi turunan contoh (mis. AWPOS) di atas base ini; lihat `docs/awcms-mini/README.md` §Reusable vs domain turunan.

**Pengecualian:** enam modul didaftarkan **langsung** di repo base ini sebagai contoh referensi (bukan preseden untuk memindahkan modul domain lain seperti POS/gudang ke repo ini) — tiga bertipe `domain` (fitur bisnis tenant) dan tiga bertipe `system` (infrastruktur platform bersama, lihat kolom Type di `docs/awcms-mini/repo-inventory.md` §Modules untuk status hidup):

- `blog-content` (`blog_content`, `type: domain`) — epic #536, Issue #537 dst., `docs/adr/0009-public-tenant-scoped-routes.md`.
- `news-portal` (`news_portal`, `type: domain`) — epic #631-#642, #649.
- `social-publishing` (`social_publishing`, `type: domain`) — epic #643-#647.
- `tenant-domain` (`tenant_domain`, `type: system`) — epic #555 tenant domain routing, `docs/adr/0010-public-host-tenant-routing.md`.
- `visitor-analytics` (`visitor_analytics`, `type: system`) — epic #617-#624.
- `data-lifecycle` (`data_lifecycle`, `type: system`) — Issue #745, epic #738 platform-evolution Wave 1, ADR-0013 §1 (System Foundation) — registry tabel bervolume tinggi kontribusi-modul dan mesin lifecycle (retensi/partisi/arsip/legal hold/purge), lihat `.claude/skills/awcms-mini-data-lifecycle/SKILL.md`.

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

| Butuh memahami…                                                                              | Baca                                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Arsitektur & fase                                                                            | `docs/awcms-mini/01_canvas_induk.md`                        |
| Kebutuhan produk                                                                             | `docs/awcms-mini/02_prd_detail_per_modul.md`                |
| Spesifikasi teknis                                                                           | `docs/awcms-mini/03_srs_detail_per_modul.md`                |
| Database/ERD/RLS                                                                             | `docs/awcms-mini/04_erd_data_dictionary.md`                 |
| Kontrak API/event                                                                            | `docs/awcms-mini/05_openapi_asyncapi_detail.md`             |
| Issue atomic                                                                                 | `docs/awcms-mini/06_github_issues_detail.md`                |
| Sprint/testing/go-live                                                                       | `docs/awcms-mini/07_sprint_testing_production_readiness.md` |
| SOP operasional                                                                              | `docs/awcms-mini/08_sop_operasional_user_guide.md`          |
| Roadmap repo/commit                                                                          | `docs/awcms-mini/09_roadmap_repository_commit.md`           |
| Coding standard                                                                              | `docs/awcms-mini/10_template_kode_coding_standard.md`       |
| Blueprint skeleton                                                                           | `docs/awcms-mini/11_implementation_blueprint.md`            |
| Prompt eksekusi                                                                              | `docs/awcms-mini/12_generator_prompt.md`                    |
| Master index/traceability                                                                    | `docs/awcms-mini/13_final_master_index_traceability.md`     |
| UI/UX, design token, layar                                                                   | `docs/awcms-mini/14_ui_ux_design_system.md`                 |
| Frontend & integrasi, offline-first                                                          | `docs/awcms-mini/15_frontend_architecture_integration.md`   |
| Data access, pooling, RLS, outbox                                                            | `docs/awcms-mini/16_backend_data_access_integration.md`     |
| Role default, permission, ABAC seed                                                          | `docs/awcms-mini/17_default_seed_rbac_abac.md`              |
| Env, feature flag, deployment                                                                | `docs/awcms-mini/18_configuration_env_reference.md`         |
| Glossary & terminologi                                                                       | `docs/awcms-mini/19_glossary_terminology.md`                |
| Threat model & arsitektur keamanan                                                           | `docs/awcms-mini/20_threat_model_security_architecture.md`  |
| Keputusan arsitektural (ADR)                                                                 | `docs/adr/README.md`                                        |
| Tata kelola, kontribusi, keamanan repo                                                       | `GOVERNANCE.md`, `CONTRIBUTING.md`, `SECURITY.md`           |
| Snapshot GitHub issue aktual, label, milestone, dan proses refresh                           | `docs/awcms-mini/github/README.md`                          |
| Inventori GENERATED modul/migration/tabel-RLS/test/route                                     | `docs/awcms-mini/repo-inventory.md`                         |
| Tata kelola pemakaian AI agent lintas keluarga produk (AWCMS/AWCMS-Mini/AWCMS-Micro/turunan) | `docs/Pedoman_Penggunaan_Agent_Keluarga_AWCMS_v1.0.pdf`     |

## Mulai dari sini

Base generik sudah selesai (v0.23.5, lihat blockquote status di atas) — tidak ada lagi "Issue 0.1" untuk dikerjakan sebagai pekerjaan baru. Untuk kontribusi baru:

- **Membangun aplikasi turunan / modul domain** (AWPOS, portal, sistem pengaduan, dsb.) di atas base ini → mulai dengan skill `awcms-mini-new-module`, lalu `awcms-mini-new-migration` → `awcms-mini-new-endpoint` → `awcms-mini-new-event` → `awcms-mini-testing` → `awcms-mini-security-review` → `awcms-mini-production-preflight`. Orkestrasi penuh: skill `awcms-mini-implement-issue`. Lihat panduan lengkap di [`docs/awcms-mini/README.md`](docs/awcms-mini/README.md) §Langkah berikutnya.
- **Perawatan / peningkatan base** (performa, UX, integrasi, keamanan, observability) → pakai skill peningkatan terkait (`awcms-mini-performance`, `awcms-mini-ux-review`, `awcms-mini-integration`, `awcms-mini-security-hardening`, `awcms-mini-observability`) dan catat di §Perawatan pasca-backlog pada `AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md`.

Pertahankan lapisan reusable base; ganti/ tambah hanya lapisan spesifik domain. Doc 09 dan doc 12 tetap acuan konvensi commit/roadmap/generator, bukan urutan pengerjaan issue foundation yang sudah selesai.
