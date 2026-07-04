# Changelog

Semua perubahan penting pada AWCMS-Mini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan proyek ini menganut [Semantic Versioning](https://semver.org/lang/id/). Entri versi dihasilkan/dikonsumsi lewat [Changesets](.changeset/README.md) (`bun run changeset` → `bun run changeset:version`).

## [Unreleased]

Belum ada perubahan yang menunggu rilis berikutnya.

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

| Versi   | Isi                                              |
| ------- | ------------------------------------------------- |
| `0.1.0` | Foundation, tenant, identity, profile             |
| `0.2.0` | RBAC/ABAC evaluator + assignment                  |
| `0.3.0` | Logging, pooling, security readiness              |
| `0.4.0` | Sync storage (outbox/inbox, conflict, R2 queue)   |
| `0.5.0` | UI shell, management reporting                    |
| `0.6.0` | Workflow approval, deployment profile             |
| `1.0.0` | Base production-ready                             |

Aplikasi turunan (mis. AWPOS) memakai peta versinya sendiri di atas base ini.

[Unreleased]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.1...HEAD
[0.0.1]: https://github.com/ahliweb/awcms-mini/commits/main
