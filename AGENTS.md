# AGENTS.md — Panduan Agent & Kontributor AWCMS-Mini

Dokumen ini adalah **kontrak kerja** untuk coding agent (Claude Code, Codex, dsb.) maupun developer manusia. Setiap sesi implementasi **wajib membaca file ini terlebih dahulu**, lalu dokumen terkait di `docs/awcms-mini/`.

## Ringkasan proyek

| Aspek          | Keputusan                                                                         |
| -------------- | --------------------------------------------------------------------------------- |
| Produk         | **Base modular monolith** — standar semua aplikasi AhliWeb (contoh domain: AWPOS) |
| Runtime        | Bun                                                                               |
| Web framework  | Astro 7 (SSR, adapter node standalone)                                            |
| Database       | PostgreSQL (postgres.js)                                                          |
| Arsitektur     | Modular monolith, microservice-ready                                              |
| Security       | RBAC + ABAC (default deny) + RLS FORCE + Audit Log                                |
| API contract   | OpenAPI (`openapi/`)                                                              |
| Event contract | AsyncAPI (`asyncapi/`)                                                            |
| Versioning     | SemVer + Changesets                                                               |
| Bahasa dokumen | Indonesia (teknis)                                                                |

Status: **Foundation (Sprint 1) selesai & tervalidasi.** Modul base berstatus skeleton (`experimental`) dengan TODO di README masing-masing. Lanjutkan dari Issue 1.1 (doc 06). Implementasi lama (Hono + emdash + plugin) diarsip di branch `legacy/pre-awpos-standard`.

## Alur kerja wajib setiap task

1. Baca AGENTS.md + doc terkait (peta di bawah) + kode/sql/openapi/asyncapi tersentuh.
2. Pastikan scope atomic (satu issue); bila ragu, pecah dulu.
3. Implementasi minimal; ikuti coding standard doc 10 dan helper `_shared` (jangan duplikasi).
4. Schema berubah → migration `NNN_awcms_*.sql` baru; API berubah → OpenAPI; event berubah → AsyncAPI.
5. Tulis/update test; jalankan validasi; update docs; tambah changeset; commit atomic + laporan.

## Aturan wajib (non-negotiable)

1. **Atomic** — satu issue per PR; jangan sentuh file unrelated.
2. **Migration** — berurutan, tanpa `BEGIN/COMMIT` di file (runner membungkus), tidak mengedit migration lama (checksum drift = error).
3. **OpenAPI/AsyncAPI** — setiap API/event baru atau berubah wajib diperbarui; `api:spec:check` harus pass.
4. **Idempotency** — mutation high-risk wajib `Idempotency-Key` (helper `_shared/idempotency.ts`).
5. **Tenant safety** — data tenant-scoped wajib `withTenant` + filter `tenant_id` + RLS ENABLE+FORCE+policy.
6. **ABAC** — endpoint non-public wajib `guardAccess`; default deny; deny overrides allow; deny high-risk → decision log.
7. **Audit** — high-risk action wajib `buildAuditEvent` dalam transaction yang sama.
8. **Masking** — data sensitif (password, token, NPWP, NIK, phone, email) di-hash/mask/redact; tidak pernah masuk response/log/audit mentah.
9. **No secret** — jangan commit `.env`, token, dump DB, data asli.
10. **Provider eksternal** — opsional via flag (doc 18); tidak boleh dipanggil di dalam DB transaction; fitur off tidak boleh mematikan aplikasi.

## Guardrail request

```text
Request → Auth → Tenant context + RLS → ABAC (default deny) → Validasi input
       → (high-risk) Idempotency-Key → Service + Transaction → Audit → Mask → Response helper
```

Error response standard via `toErrorResponse` — tanpa stack trace.

## Perintah standar

```bash
bun install
bun run dev                  # astro dev (http://localhost:4321)
bun run build && bun run start
bun run db:migrate           # migration berurutan + checksum
bun run db:migrate:status
bun run api:spec:check       # OpenAPI/AsyncAPI ↔ registry modul
bun run api:contract:test    # terhadap server berjalan
bun test                     # unit test
bun run db:pool:health
bun run security:readiness   # pemeriksaan keamanan statis
bun run production:preflight # seluruh checklist pre-deploy
bun run changeset            # versioning per PR
```

PostgreSQL lokal: `docker compose up -d postgres`.

## Struktur repository

Lihat doc 09. Inti: `src/lib` (infrastruktur), `src/modules/_shared` (kontrak & helper standar), `src/modules/<module>` (modular monolith: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/`, `README.md`), `src/pages/api/v1` (route tipis), `sql/`, `openapi/`, `asyncapi/`, `scripts/`, `docs/awcms-mini/`, `deploy/`, `tests/`.

## Peta modul base

`_shared` · `tenant-admin` · `identity-access` · `profile-identity` · `localization-ui` · `observability-logging` · `database-connectivity` · `workflow-approval` · `management-reporting` · `ui-experience` · `production-security-readiness` · `sync-storage`. Registry + validasi dependency: `src/modules/index.ts`. Aplikasi domain menambah modulnya sendiri (pola: paket AWPOS).

## Skill proyek (`.claude/skills/`)

| Butuh…                                   | Skill                             |
| ---------------------------------------- | --------------------------------- |
| Kerjakan issue atomic (orkestrator)      | `awcms-mini-implement-issue`      |
| Scaffold modul baru                      | `awcms-mini-new-module`           |
| Migration SQL (tabel/index/RLS)          | `awcms-mini-new-migration`        |
| Endpoint REST + OpenAPI                  | `awcms-mini-new-endpoint`         |
| Domain event + AsyncAPI                  | `awcms-mini-new-event`            |
| Idempotency mutation high-risk           | `awcms-mini-idempotency`          |
| ABAC default-deny + RLS                  | `awcms-mini-abac-guard`           |
| Audit high-risk + redaction              | `awcms-mini-audit-log`            |
| Masking data sensitif                    | `awcms-mini-sensitive-data`       |
| Sync HMAC + anti-replay                  | `awcms-mini-sync-hmac`            |
| Review keamanan modul                    | `awcms-mini-security-review`      |
| Review pull request                      | `awcms-mini-pr-review`            |
| Tulis test berlapis                      | `awcms-mini-testing`              |
| Preflight & go-live                      | `awcms-mini-production-preflight` |
| Layar/komponen UI sesuai design system   | `awcms-mini-ui-screen`            |
| Rilis versi (Changesets, tag, CHANGELOG) | `awcms-mini-release`              |
| Migrasi data legacy (dry-run, backfill)  | `awcms-mini-legacy-migration`     |

Skill merujuk `docs/awcms-mini/*` sebagai sumber kebenaran; bila standar berubah, perbarui doc **dan** skill terkait.

## Subagents (`.claude/agents/`)

| Agent                         | Peran                                 | Tools     |
| ----------------------------- | ------------------------------------- | --------- |
| `awcms-mini-coder`            | Implementasi issue end-to-end         | Semua     |
| `awcms-mini-reviewer`         | Review PR/diff terhadap DoD           | Read-only |
| `awcms-mini-security-auditor` | Audit keamanan + verdict PASS/BLOCKED | Read-only |

Alur: issue → coder → reviewer → auditor (modul sensitif) → merge. Critical finding = BLOCKED.

## Konvensi commit

`<type>(<scope>): <summary>` — types/scopes di doc 09. Branch: `feature/<issue>-<name>`, `fix/<issue>-<name>`, `release/vX.Y.Z`.

## Definition of Done

Scope sesuai issue · migration/OpenAPI/AsyncAPI bila relevan · validasi input + ABAC/RLS + audit + masking · test pass · build pass · docs update · changeset · laporan implementasi (template doc 10).

## Peta dokumen

| Butuh memahami…          | Baca                                                        |
| ------------------------ | ----------------------------------------------------------- |
| Arsitektur & fase        | `docs/awcms-mini/01_canvas_induk.md`                        |
| Kebutuhan produk         | `docs/awcms-mini/02_prd_detail_per_modul.md`                |
| Spesifikasi teknis       | `docs/awcms-mini/03_srs_detail_per_modul.md`                |
| Database/ERD/RLS         | `docs/awcms-mini/04_erd_data_dictionary.md`                 |
| Kontrak API/event        | `docs/awcms-mini/05_openapi_asyncapi_detail.md`             |
| Issue atomic             | `docs/awcms-mini/06_github_issues_detail.md`                |
| Sprint/testing/go-live   | `docs/awcms-mini/07_sprint_testing_production_readiness.md` |
| SOP operasional          | `docs/awcms-mini/08_sop_operasional_user_guide.md`          |
| Roadmap repo/commit      | `docs/awcms-mini/09_roadmap_repository_commit.md`           |
| Coding standard          | `docs/awcms-mini/10_template_kode_coding_standard.md`       |
| Blueprint skeleton       | `docs/awcms-mini/11_implementation_blueprint.md`            |
| Prompt eksekusi          | `docs/awcms-mini/12_generator_prompt.md`                    |
| Traceability             | `docs/awcms-mini/13_final_master_index_traceability.md`     |
| UI/UX & design token     | `docs/awcms-mini/14_ui_ux_design_system.md`                 |
| Frontend & offline-first | `docs/awcms-mini/15_frontend_architecture_integration.md`   |
| Data access & RLS        | `docs/awcms-mini/16_backend_data_access_integration.md`     |
| Seed/RBAC/ABAC           | `docs/awcms-mini/17_default_seed_rbac_abac.md`              |
| Env & deployment         | `docs/awcms-mini/18_configuration_env_reference.md`         |
| Glossary                 | `docs/awcms-mini/19_glossary_terminology.md`                |

## Mulai dari sini

```text
Kerjakan Issue 1.1 — Setup wizard API (doc 06).
Lanjutkan sesuai urutan doc 06 dan doc 09.
```
