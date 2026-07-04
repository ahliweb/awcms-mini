# Changelog

Semua perubahan penting pada AWCMS-Mini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan proyek ini menganut [Semantic Versioning](https://semver.org/lang/id/). Entri versi baru dihasilkan oleh [Changesets](.changeset/README.md) saat rilis (`bun run changeset:version`); entri di bawah `[Unreleased]` adalah ringkasan manual untuk baseline dokumentasi yang mendahului tooling.

## [Unreleased]

Baseline paket dokumentasi & tooling. Belum ada kode aplikasi yang dirilis; rilis bertag pertama direncanakan **0.1.0** (Foundation) sesuai `docs/awcms-mini/09_roadmap_repository_commit.md`.

### Added

- Paket dokumen master **01–19** (`docs/awcms-mini/`): perencanaan (01–03), kontrak (04–05), eksekusi (06–13), desain teknis implementasi (14–18), glossary (19).
- `AGENTS.md` — kontrak kerja coding agent.
- 17 **skill proyek** Claude Code di `.claude/skills/`.
- Audit standar pengembangan software untuk baseline docs-only (`docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`).
- Snapshot dokumentasi GitHub issue di `docs/awcms-mini/github/`, terpisah open/closed dengan batas 100 issue per file, plus label/milestone dan proses refresh.
- Diagram Mermaid di seluruh dokumen kunci.
- Versioning (SemVer) + **Changesets** + `CHANGELOG.md` + `package.json` anchor + `bun.lock` + `.gitignore`.

## Peta versi rencana (dari doc 09)

| Versi | Isi |
|---|---|
| `0.1.0` | Foundation, tenant, identity, profile |
| `0.2.0` | Product, stock, POS checkout |
| `0.3.0` | Atomic posting, logging, pooling |
| `0.4.0` | Receipt, CRM, sync |
| `0.5.0` | Warehouse basic |
| `0.6.0` | Tax/Coretax readiness |
| `0.7.0` | UI admin/operator/customer |
| `0.8.0` | Reporting dan AI |
| `0.9.0` | Security readiness dan deployment |
| `1.0.0` | Production-ready MVP |

[Unreleased]: https://github.com/ahliweb/awcms-mini/commits/main
