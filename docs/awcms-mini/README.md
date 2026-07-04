# AWCMS-Mini Documentation Package

Paket dokumen master untuk **AWCMS-Mini — base modular monolith** (Bun + Astro + PostgreSQL). Struktur dan penomoran mengikuti paket dokumen AWPOS (`/docs/awpos` pada repo awpos), tetapi cakupannya adalah **lapisan base yang reusable** — bukan domain POS.

> Sebelum coding, baca [`../../AGENTS.md`](../../AGENTS.md), lalu gunakan skill proyek di [`../../.claude/skills/`](../../.claude/skills/README.md).

## Hubungan dengan AWPOS

AWPOS adalah **contoh aplikasi domain** yang dibangun di atas base ini. Pembagian tanggung jawab:

| Lapisan                   | Dimiliki                                                                                                                                              | Contoh                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Base (repo ini)           | Struktur modular monolith, module contract, `_shared`, RBAC/ABAC/RLS, audit, migration/OpenAPI/AsyncAPI, logging redaction, konfigurasi, skill proyek | `tenant_admin`, `identity_access`, `profile_identity`, `observability_logging`, … |
| Domain (aplikasi turunan) | Modul bisnis + schema + endpoint + layar spesifik                                                                                                     | `catalog_inventory`, `sales_pos`, `warehouse_management`, `accounting_tax`, …     |

Untuk membangun aplikasi baru: fork/gunakan base ini, tambah modul domain di `src/modules/`, migration `NNN_awcms_<area>_*.sql` berikutnya, path OpenAPI di `openapi/modules/`, event di AsyncAPI, lalu ikuti alur dokumen 01 → 19 milik aplikasi tersebut.

## Dokumen (per lapisan)

### Lapisan A — Perencanaan (why & what)

|  No | File                         | Isi                                       |
| --: | ---------------------------- | ----------------------------------------- |
|   1 | `01_canvas_induk.md`         | Canvas induk arsitektur & fase base       |
|   2 | `02_prd_detail_per_modul.md` | PRD modul base                            |
|   3 | `03_srs_detail_per_modul.md` | SRS modul base + requirement lintas modul |

### Lapisan B — Kontrak (interface)

|  No | File                            | Isi                                           |
| --: | ------------------------------- | --------------------------------------------- |
|   4 | `04_erd_data_dictionary.md`     | ERD, data dictionary, RLS, index, klasifikasi |
|   5 | `05_openapi_asyncapi_detail.md` | Kontrak REST & domain event base              |

### Lapisan C — Eksekusi (how & process)

|  No | File                                        | Isi                                    |
| --: | ------------------------------------------- | -------------------------------------- |
|   6 | `06_github_issues_detail.md`                | Issue atomic base                      |
|   7 | `07_sprint_testing_production_readiness.md` | Sprint, testing, go-live gates         |
|   9 | `09_roadmap_repository_commit.md`           | Struktur repo, branch, commit, release |
|  10 | `10_template_kode_coding_standard.md`       | Coding standard & template             |
|  11 | `11_implementation_blueprint.md`            | Blueprint skeleton per sprint          |
|  12 | `12_generator_prompt.md`                    | Prompt eksekusi coding agent           |
|  13 | `13_final_master_index_traceability.md`     | Master index & traceability            |

### Lapisan D — Desain teknis implementasi (build)

|  No | File                                      | Isi                                        |
| --: | ----------------------------------------- | ------------------------------------------ |
|  14 | `14_ui_ux_design_system.md`               | Design system, token, komponen, a11y, i18n |
|  15 | `15_frontend_architecture_integration.md` | Arsitektur frontend, API client, offline   |
|  16 | `16_backend_data_access_integration.md`   | Data access, pooling, RLS, transaction     |
|  17 | `17_default_seed_rbac_abac.md`            | Role default, permission, ABAC, seed       |
|  18 | `18_configuration_env_reference.md`       | Env, feature flag, topologi deployment     |

### Lapisan E — Operasi & referensi

|  No | File                               | Isi                          |
| --: | ---------------------------------- | ---------------------------- |
|   8 | `08_sop_operasional_user_guide.md` | SOP operasional & user guide |
|  19 | `19_glossary_terminology.md`       | Glossary & terminologi       |

## Reading path

| Tujuan                         | Urutan baca                             |
| ------------------------------ | --------------------------------------- |
| Memahami base & arsitektur     | 01 → 02 → 03 → 19                       |
| Mulai coding (foundation)      | AGENTS.md → 11 → 16 → 18 → 05 → 04      |
| Implementasi modul backend     | 03 → 04 → 05 → 10 → 16 → 17             |
| Implementasi UI/frontend       | 14 → 15 → 05 → 08                       |
| Setup akses & multi-tenant     | 17 → 16 → 03                            |
| Testing & go-live              | 07 → 12 → 13                            |
| Membangun aplikasi domain baru | README ini → 01 → 10 → 11 → paket AWPOS |

## Prinsip implementasi

1. Baca dokumen dan repository sebelum mengedit.
2. Kerjakan atomic issue; jangan ubah modul unrelated.
3. Schema berubah → migration baru; API berubah → OpenAPI; event berubah → AsyncAPI.
4. Mutation high-risk → idempotency; data tenant-scoped → tenant context + ABAC + RLS.
5. Aktivitas high-risk → audit log; data sensitif → mask/redact.
