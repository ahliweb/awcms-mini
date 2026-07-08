# AWCMS-Mini Documentation Package

Folder ini berisi paket dokumen master untuk pengembangan **AWCMS-Mini Modular Monolith Standard**. Struktur dan urutan dokumen mengikuti repo referensi AWPOS, dengan penyesuaian konteks menjadi base AWCMS-Mini untuk aplikasi domain berikutnya.

> Sebelum coding, baca [`../../AGENTS.md`](../../AGENTS.md) untuk aturan wajib dan alur kerja agent, serta gunakan **skill proyek** di [`../../.claude/skills/`](../../.claude/skills/README.md).

> **Penting — konten domain vs base.** Dokumen **01, 06, 09** dan `AGENTS.md` sudah **generik (base)**. Dokumen **02–19** memakai domain retail/POS bergaya **AWPOS** sebagai **contoh ilustratif**: **pola & standar**-nya reusable, tetapi **entitas, endpoint, layar, dan istilah domain** (produk, POS, gudang, pajak, CRM, AI, dsb.) adalah ilustrasi yang **diganti** aplikasi turunan. Tiap dokumen 02–19 memuat banner penanda di bagian atasnya. Keputusan arsitektural base dicatat di [`../adr/`](../adr/README.md).

## Peta dokumen

```mermaid
flowchart TB
  subgraph Perencanaan
    D1[01 Canvas Induk]
    D2[02 PRD]
    D3[03 SRS]
  end
  subgraph Kontrak
    D4[04 ERD]
    D5[05 OpenAPI/AsyncAPI]
  end
  subgraph Eksekusi
    D6[06 Issues]
    D7[07 Sprint/Test]
    D9[09 Roadmap Repo]
    D10[10 Coding Standard]
    D11[11 Blueprint]
    D12[12 Generator Prompt]
  end
  subgraph Operasi
    D8[08 SOP/User Guide]
    D13[13 Traceability]
  end
  subgraph DesainTeknis["Desain teknis implementasi"]
    D14[14 UI/UX Design System]
    D15[15 Frontend & Integrasi]
    D16[16 Backend & Database]
    D17[17 Seed/RBAC/ABAC]
    D18[18 Config/Env]
  end
  subgraph Referensi
    D19[19 Glossary]
    D20[20 Threat Model]
    ADR[docs/adr ADRs]
    GH[GitHub Snapshot]
  end

  D1 --> D2 --> D3 --> D4 --> D5 --> D6 --> D7
  D7 --> D9 --> D10 --> D11 --> D12 --> D13
  D3 --> D8
  D13 -.acuan.-> D6
  D5 --> D14 --> D15 --> D16
  D4 --> D16
  D3 --> D17
  D11 --> D18
  D19 -.rujukan istilah.-> D1
  D20 -.gates keamanan.-> D7
  ADR -.dasar keputusan.-> D1
  GH -.state aktual.-> D6
```

## Keputusan final stack

- **Bun** sebagai runtime.
- **Backend Bun-only**; Node.js hanya boleh lewat pengecualian tertulis bila Bun belum mendukung capability yang diperlukan.
- **Astro 7** sebagai web framework.
- **PostgreSQL** sebagai database utama.
- **Modular monolith** sebagai arsitektur utama.
- **Microservice-ready**, tetapi tidak dipisah sejak awal.
- **Offline-first / LAN-first**, dengan optional online sync.
- **Cloudflare R2 optional** untuk object/file storage.
- **Provider eksternal opsional** (pesan/notifikasi/AI) via feature flag + outbox — ini adalah _slot_ base; provider konkret (mis. StarSender/Mailketing/AI analyst pada AWPOS) adalah contoh domain turunan.
- **OpenAPI** untuk API contract.
- **AsyncAPI** untuk domain event contract.

## Dokumen (per lapisan)

Dokumen dikelompokkan mengikuti alur pengembangan agar mudah diimplementasi.

### Lapisan A — Perencanaan (why & what)

|  No | File                         | Isi                                              |
| --: | ---------------------------- | ------------------------------------------------ |
|   1 | `01_canvas_induk.md`         | Canvas induk tahapan pengembangan dan arsitektur |
|   2 | `02_prd_detail_per_modul.md` | Product Requirement Document detail per modul    |
|   3 | `03_srs_detail_per_modul.md` | Software Requirement Specification detail        |

### Lapisan B — Kontrak (interface)

|  No | File                            | Isi                                         |
| --: | ------------------------------- | ------------------------------------------- |
|   4 | `04_erd_data_dictionary.md`     | ERD, data dictionary, RLS, index, retention |
|   5 | `05_openapi_asyncapi_detail.md` | Kontrak REST API dan domain event           |

### Lapisan C — Eksekusi (how & process)

|  No | File                                        | Isi                                                |
| --: | ------------------------------------------- | -------------------------------------------------- |
|   6 | `06_github_issues_detail.md`                | GitHub issues atomic siap copy-paste               |
|   7 | `07_sprint_testing_production_readiness.md` | Sprint plan, testing, go-live checklist            |
|   9 | `09_roadmap_repository_commit.md`           | Roadmap repository, branch, commit, release        |
|  10 | `10_template_kode_coding_standard.md`       | Template kode dan coding standard                  |
|  11 | `11_implementation_blueprint.md`            | Skeleton repository dan blueprint per sprint       |
|  12 | `12_generator_prompt.md`                    | Prompt eksekusi coding agent                       |
|  13 | `13_final_master_index_traceability.md`     | Master index, traceability matrix, checklist final |

### Lapisan D — Desain teknis implementasi (build)

|  No | File                                      | Isi                                                       |
| --: | ----------------------------------------- | --------------------------------------------------------- |
|  14 | `14_ui_ux_design_system.md`               | Design system, token, komponen, layar, a11y, i18n         |
|  15 | `15_frontend_architecture_integration.md` | Arsitektur frontend, API client, auth, offline-first      |
|  16 | `16_backend_data_access_integration.md`   | Data access, pooling, RLS, transaction, outbox, migration |
|  17 | `17_default_seed_rbac_abac.md`            | Role default, permission matrix, ABAC policy, seed        |
|  18 | `18_configuration_env_reference.md`       | Referensi env, feature flag, topologi deployment          |

### Lapisan E — Operasi & referensi

|  No | File                                        | Isi                                                                                                    |
| --: | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
|   8 | `08_sop_operasional_user_guide.md`          | SOP operasional dan user guide                                                                         |
|  19 | `19_glossary_terminology.md`                | Glossary & terminologi lintas dokumen                                                                  |
|  20 | `20_threat_model_security_architecture.md`  | Threat model (STRIDE), trust boundary, kontrol keamanan berlapis (dokumen base, bukan contoh domain)   |
|   – | `database-migrations.md`                    | Panduan runner migrasi PostgreSQL Bun-native                                                           |
|   – | `deployment-profiles.md`                    | Profil deployment (development/staging/production/offline-LAN) dan model dua-peran basis data          |
|   – | `deploy-coolify.md`                         | Panduan deploy Coolify: single-VPS, multi-aplikasi, opsi PostgreSQL, checklist keamanan (Issue #462)   |
|   – | `derived-application-guide.md`              | Panduan membangun aplikasi turunan di atas base (9 langkah + 5 contoh ilustratif + checklist keamanan) |
|   – | `examples/minimal-domain-module.md`         | Contoh konkret satu modul domain minimal (Issue #463)                                                  |
|   – | `examples/wizard-form-pattern.md`           | Reusable multi-step wizard form pattern: komponen, helper, pola i18n (Issue #479)                      |
|   – | `examples/wizard-derived-module-example.md` | Contoh pemakaian wizard end-to-end pada modul domain turunan (Issue #482)                              |
|   – | `derived-app-pilot-plan.md`                 | Rencana pilot aplikasi turunan pertama — rekomendasi AWPOS (Issue #465)                                |
|   – | `../../openapi/` dan `../../asyncapi/`      | Baseline kontrak OpenAPI/AsyncAPI dan validator `api:spec:check`                                       |

### Architecture Decision Records

| Folder                        | Isi                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`../adr/`](../adr/README.md) | Keputusan arsitektural base (modular monolith, Bun-only, RLS, RBAC/ABAC, soft delete, offline-first, kontrak) |

### Audit repo

| File                                       | Isi                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` | Audit kepatuhan baseline, foundation skeleton, dan migration runner terhadap standar Bun, Astro 7, dan PostgreSQL |

### Snapshot GitHub

| File                          | Isi                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `github/README.md`            | Proses pencatatan GitHub issue, aturan maksimal 100 issue per file, indeks snapshot, dan ringkasan live count saat refresh |
| `github/issues-open-001.md`   | Snapshot issue `OPEN` saat ini                                                                                             |
| `github/issues-closed-001.md` | Snapshot issue `CLOSED` saat ini                                                                                           |
| `github/labels-milestones.md` | Snapshot label dan milestone GitHub                                                                                        |
| `github/security.md`          | Snapshot setup GitHub Security, alert count, dan file security automation                                                  |

## Reading path (sesuai tujuan)

| Tujuan                       | Urutan baca                                          |
| ---------------------------- | ---------------------------------------------------- |
| Memahami produk & arsitektur | 01 → 02 → 03 → 19                                    |
| Mulai coding (foundation)    | AGENTS.md → 11 → 16 → 18 → 05 → 04                   |
| Implementasi modul backend   | 03 (modul) → 04 → 05 → 10 → 16 → 17                  |
| Implementasi UI/frontend     | 14 → 15 → 05 → 08                                    |
| Setup akses & multi-tenant   | 17 → 16 → 03                                         |
| Testing & go-live            | 07 → 12 → 13                                         |
| Operasional & handover       | 08 → 09 → 13                                         |
| Audit standar repo           | `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` → 09 → 11 |
| Sinkronisasi GitHub issue    | 06 → `github/README.md` → 09 → 13                    |

## AWCMS-Mini sebagai standar pengembangan

AWCMS-Mini sengaja disusun agar bisa dipakai sebagai **template/contoh** untuk mengembangkan aplikasi lain di atas base yang sama. Bagian yang **generik & reusable** (pola AWCMS-Mini) vs **spesifik domain turunan**:

| Reusable (pola AWCMS-Mini)                                         | Spesifik domain turunan                       |
| ------------------------------------------------------------------ | --------------------------------------------- |
| Struktur modular monolith + module contract (10, 11)               | Modul domain aplikasi (02, 03)                |
| Baseline keamanan RBAC + ABAC + RLS + audit (16, 17)               | Matriks role & policy domain (17)             |
| Konvensi migration, OpenAPI, AsyncAPI (04, 05, 16)                 | Schema & endpoint domain (04, 05)             |
| Soft delete tenant-safe untuk master/config/draft (04, 05, 10, 16) | Resource domain mana yang boleh restore/purge |
| Design system & shell UI (14, 15)                                  | Layar domain/operator/portal (14)             |
| Offline-first (service worker + outbox) (15, 16)                   | Alur transaksi/operasional domain (08)        |
| Skill proyek `.claude/skills/`                                     | —                                             |
| Standar commit/roadmap/preflight (09, 07)                          | —                                             |

Untuk membangun aplikasi baru di atas AWCMS-Mini: pertahankan lapisan reusable, ganti lapisan spesifik domain dengan kebutuhan aplikasi Anda, dan ikuti alur dokumen 01 → 20 (plus ADR di [`../adr/`](../adr/README.md)). Panduan langkah-demi-langkah (9 langkah berbasis skill nyata + 5 contoh aplikasi turunan + checklist keamanan): [`derived-application-guide.md`](derived-application-guide.md).

## Versioning

SemVer + [Changesets](../../.changeset/README.md); riwayat di [`../../CHANGELOG.md`](../../CHANGELOG.md). Setiap PR yang mengubah perilaku wajib menambah changeset. Peta versi & workflow: `09_roadmap_repository_commit.md`.

## Prinsip implementasi

1. Baca dokumen dan repository sebelum mengedit.
2. Kerjakan atomic issue.
3. Jangan mengubah modul unrelated.
4. Jika schema berubah, tambahkan migration.
5. Jika API berubah, update OpenAPI.
6. Jika event berubah, update AsyncAPI.
7. Jika mutation high-risk, gunakan idempotency.
8. Jika data tenant-scoped, gunakan tenant context, ABAC, dan RLS.
9. Jika aktivitas high-risk, tulis audit log.
10. Jika data sensitif, mask/redact.
11. Jika resource bisa dihapus, gunakan soft delete + filter default `deleted_at IS NULL`; restore/purge harus berizin dan diaudit.

## Langkah berikutnya

**Base generik sudah selesai** (v0.23.5) — seluruh 18 issue backlog base (doc 06) + peningkatan pasca-backlog milestone M9 tuntas (ringkasan di [`../../README.md`](../../README.md) §Versioning dan log per-issue di `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`). Tenant/office, identity/login, RBAC/ABAC, Sync Storage, reporting, audit/logging, workflow approval, dan deployment profile **sudah** ada dan berjalan; jangan membangunnya ulang.

Kontribusi baru masuk salah satu dari dua jalur:

**A. Membangun aplikasi turunan / modul domain** (mis. AWPOS retail/POS, portal sekolah, sistem pengaduan, sistem manajemen mutu) di atas base ini:

1. Definisikan PRD/SRS domain (pola doc 02/03, ganti entitas retail/POS ilustratif dengan domain Anda).
2. Scaffold modul domain di `src/modules/` — skill `awcms-mini-new-module`.
3. Migration PostgreSQL + RLS tenant-scoped — skill `awcms-mini-new-migration`.
4. Seed RBAC/ABAC domain (doc 17) — permission/role/policy khusus domain.
5. Endpoint REST + OpenAPI — skill `awcms-mini-new-endpoint`; domain event + AsyncAPI — skill `awcms-mini-new-event`.
6. UI/admin screen sesuai design system (doc 14/15) — skill `awcms-mini-ui-screen`; string via i18n — skill `awcms-mini-i18n`; form multi-step — skill `awcms-mini-wizard-form`.
7. Audit/logging aksi high-risk — skill `awcms-mini-audit-log`; idempotency mutation high-risk — skill `awcms-mini-idempotency`.
8. Test berlapis — skill `awcms-mini-testing`; E2E browser sungguhan (Playwright + Bun) — skill `awcms-mini-browser-test`; review keamanan — skill `awcms-mini-security-review`.
9. Deployment & go-live — skill `awcms-mini-production-preflight`; pilih & jalankan profil deployment — skill `awcms-mini-deploy` (`deployment-profiles.md`, atau `deploy-coolify.md` bila Coolify).

Orkestrasi penuh satu unit kerja: skill `awcms-mini-implement-issue`. Pertahankan lapisan reusable (tabel §AWCMS-Mini sebagai standar pengembangan di atas), ganti hanya lapisan spesifik domain.

**B. Perawatan / peningkatan base** (performa, UX/a11y, integrasi, keamanan, observability): pakai skill peningkatan terkait dan catat di §Perawatan pasca-backlog pada `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`.

Dokumen `09_roadmap_repository_commit.md` dan `12_generator_prompt.md` tetap acuan konvensi commit/roadmap/generator — bukan lagi daftar urutan issue foundation yang sudah tuntas.
