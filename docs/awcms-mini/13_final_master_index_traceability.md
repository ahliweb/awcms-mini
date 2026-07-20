# Bagian 13 — Final Master Index dan Traceability Matrix

> **Contoh domain (ilustratif).** Dokumen ini memakai domain retail/POS bergaya AWPOS sebagai contoh berjalan. **Pola & standar**-nya reusable untuk base AWCMS-Mini; **entitas, endpoint, layar, dan istilah domain** (produk, POS, gudang, pajak, CRM, AI, dsb.) adalah ilustrasi yang **diganti** oleh aplikasi turunan. Lihat [README paket dokumen](README.md) §Reusable vs domain turunan.

## Tujuan

Dokumen ini menjadi master index final untuk seluruh paket dokumen AWCMS-Mini, sekaligus traceability matrix dari kebutuhan bisnis sampai implementasi, test, security, SOP, dan production readiness.

## Master index dokumen

| Bagian | File                                                                                                                | Fungsi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -----: | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|      1 | `01_canvas_induk.md`                                                                                                | Canvas arsitektur dan fase pengembangan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|      2 | `02_prd_detail_per_modul.md`                                                                                        | Kebutuhan produk per modul                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|      3 | `03_srs_detail_per_modul.md`                                                                                        | Spesifikasi teknis per modul                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|      4 | `04_erd_data_dictionary.md`                                                                                         | ERD, data dictionary, RLS, index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|      5 | `05_openapi_asyncapi_detail.md`                                                                                     | API contract dan event contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|      6 | `06_github_issues_detail.md`                                                                                        | Issue atomic siap copy-paste                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|      7 | `07_sprint_testing_production_readiness.md`                                                                         | Sprint, testing, go-live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|      8 | `08_sop_operasional_user_guide.md`                                                                                  | SOP operasional dan user guide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|      9 | `09_roadmap_repository_commit.md`                                                                                   | Roadmap repo, branch, commit, release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|     10 | `10_template_kode_coding_standard.md`                                                                               | Template kode dan coding standard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|     11 | `11_implementation_blueprint.md`                                                                                    | Skeleton dan blueprint per sprint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|     12 | `12_generator_prompt.md`                                                                                            | Prompt eksekusi coding agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|     13 | `13_final_master_index_traceability.md`                                                                             | Master index dan traceability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|     14 | `14_ui_ux_design_system.md`                                                                                         | Design system, token, komponen, layar, a11y, i18n                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|     15 | `15_frontend_architecture_integration.md`                                                                           | Arsitektur frontend, API client, auth, offline-first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|     16 | `16_backend_data_access_integration.md`                                                                             | Data access, pooling, RLS, transaction, outbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|     17 | `17_default_seed_rbac_abac.md`                                                                                      | Role default, permission matrix, ABAC policy, seed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|     18 | `18_configuration_env_reference.md`                                                                                 | Referensi env, feature flag, topologi deployment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|     19 | `19_glossary_terminology.md`                                                                                        | Glossary & terminologi lintas dokumen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|     20 | `20_threat_model_security_architecture.md`                                                                          | Threat model (STRIDE), trust boundary, kontrol keamanan berlapis (dokumen base)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|     21 | `21_module_admission_governance.md`                                                                                 | Kategori modul, pohon keputusan admission, pemetaan registry, trusted registry policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|    ADR | `../adr/README.md`                                                                                                  | Architecture Decision Records (keputusan base + alasan) — termasuk `../adr/0013-extension-layers-and-boundary-model.md` (Issue #739, epic #738 `platform-evolution`): lapisan ekstensi Core/System Foundation/Official Optional Business Foundation/SaaS Control Plane/ERP Extension/Derived Application, batas tenant vs legal entity vs organization unit, data-ownership matrix, dan kriteria evidence-based ekstraksi layanan; `../adr/0014-deterministic-build-time-module-composition.md` (Issue #740, epic #738): titik ekstensi `application-registry.ts`, taksonomi kegagalan komposisi, dan konvensi namespace migration; dan `../adr/0020-erp-extension-readiness-contracts.md` (Issue #755, epic #738 Wave 4): kontrak business transaction/posting/period-lock/item/currency/UoM/inventory-movement/reconciliation/report-projection untuk ekstensi ERP, tanpa modul/tabel ERP baru di base |
|   Gov. | `../../GOVERNANCE.md`, `../../CONTRIBUTING.md`, `../../SECURITY.md`, `../../CODE_OF_CONDUCT.md`, `../../SUPPORT.md` | Tata kelola, kontribusi, keamanan, komunitas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|     CI | `../../.github/workflows/`                                                                                          | CodeQL + CI: lint, docs-check, typecheck, unit test, hygiene (Bun-only, no-`.env`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|  Tools | `../../scripts/`, `../../tests/`                                                                                    | Pemeriksa docs Bun-native (`scripts/lib/docs-checks.mjs`) + unit/integration test (`bun test`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GitHub | `github/README.md`                                                                                                  | Snapshot issue aktual, label, milestone, dan proses refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Executive summary final

AWCMS-Mini adalah standar modular monolith berbasis AWCMS-Mini dengan stack final:

```text
Bun-only backend + Astro 7 + PostgreSQL + Modular Monolith + Offline-first/LAN-first
```

Keputusan teknis:

1. PostgreSQL sebagai database utama.
2. Bun sebagai runtime dan backend platform; Node.js hanya boleh lewat pengecualian tertulis bila Bun belum mendukung capability yang diperlukan.
3. Astro 7 sebagai web framework.
4. Modular monolith, microservice-ready.
5. Offline-first/LAN-first.
6. Optional online sync.
7. Optional Cloudflare R2.
8. Optional StarSender/Mailketing.
9. Optional AI analyst via safe views.
10. RBAC + ABAC + RLS + Audit Log.
11. Coretax-ready via staging/XML/checksum/approval/audit.
12. Soft delete tenant-safe untuk master/config/draft; posted/append-only entity tetap immutable.

## Rantai traceability

```mermaid
flowchart LR
  BN[Business Need] --> PRD[PRD 02]
  PRD --> SRS[SRS 03]
  SRS --> ERD[ERD 04]
  ERD --> API[OpenAPI/AsyncAPI 05]
  API --> ISS[Issues 06]
  ISS --> SPR[Sprint 07]
  SPR --> TST[Test 07]
  TST --> SOP[SOP 08]
  SOP --> DONE([Traceable & Auditable])
```

## Traceability — Business Need ke Modul

> **Tabel NYATA, bukan ilustrasi.** Seperti §"Matrix Modul vs Migration",
> tabel ini mendokumentasikan modul yang benar-benar terdaftar di
> `listBaseModules()` — banner "contoh domain" di puncak dokumen **tidak**
> berlaku di sini. Versi sebelumnya memetakan 9 dari 22 kebutuhan ke modul
> yang tak pernah ada di repo base (`Catalog Inventory`, `Sales POS`,
> `Shared Stock Routing`, `Warehouse`, `CRM`, `Accounting Tax`,
> `AI Analyst`), sehingga tak bisa ditelusuri ke kode mana pun (Issue #828
> Temuan 2). Kebutuhan domain retail/POS itu kini **dipindah** ke blok
> "Kebutuhan domain aplikasi turunan" di bawah tabel.

| Business Need              | Modul (`key`)             | Output nyata                                         |
| -------------------------- | ------------------------- | ---------------------------------------------------- |
| Multi tenant/cabang        | `tenant_admin`            | Tenant, office, physical location, tenant settings   |
| User login dan role        | `identity_access`         | Identity, tenant user, role, session                 |
| Hak akses fleksibel        | `identity_access`         | RBAC, ABAC, decision log, business scope/SoD         |
| Profil/party terpusat      | `profile_identity`        | Party, identifier, entity link                       |
| Arsip master data aman     | Semua modul master        | Soft delete, restore, purge policy                   |
| Offline sync               | `sync_storage`            | Outbox, inbox, conflict, R2 object queue             |
| Dashboard & laporan        | `reporting`               | View & projection laporan generik, export dispatcher |
| Audit/troubleshooting      | `logging`                 | Audit trail, structured log, correlation ID, metrics |
| Approval high-risk         | `workflow`                | Workflow definition/instance/task/decision           |
| Draft form bertahap        | `form_drafts`             | Draft store server-side lintas sesi/perangkat        |
| Email transaksional        | `email`                   | Template, message, recipient, dispatcher outbox      |
| Modul on/off per tenant    | `module_management`       | Registry modul, enable/disable, settings, permission |
| Routing publik per domain  | `tenant_domain`           | Mapping domain/subdomain tenant                      |
| Statistik pengunjung       | `visitor_analytics`       | Session/event privacy-first, rollup                  |
| Retensi & purge data besar | `data_lifecycle`          | Registry tabel, retensi, arsip, legal hold, purge    |
| Event domain andal         | `domain_event_runtime`    | Outbox transaksional, dispatcher, replay             |
| Integrasi eksternal        | `integration_hub`         | Endpoint, subscription, inbound/outbound delivery    |
| Master wilayah Indonesia   | `idn_admin_regions`       | Dataset & region provinsi/kabupaten/kecamatan/desa   |
| Konten/blog tenant         | `blog_content`            | Post, page, term, menu, widget, revision             |
| Portal berita & media      | `news_portal`             | Homepage section, media registry, ad placement       |
| Auto-posting sosial        | `social_publishing`       | Job/outbox posting provider-neutral                  |
| Struktur organisasi        | `organization_structure`  | Legal entity, unit, hierarki, assignment             |
| Reference data             | `reference_data`          | Value set, item, kontribusi modul                    |
| Metadata dokumen           | `document_infrastructure` | Document, version, classification, penomoran         |
| Import/export data         | `data_exchange`           | Descriptor, staged row, import batch, export job     |

**Kebutuhan domain aplikasi turunan (ilustratif — tidak ada di base).**
Kebutuhan retail/POS di bawah dulu tercantum sebagai baris tabel di atas
seolah punya modul base; nyatanya **tak satu pun** dibangun di repo ini.
Aplikasi turunan (mis. AWPOS) menyumbangkan modulnya sendiri lewat
`src/modules/application-registry.ts` (Issue #740): master produk & stok,
transaksi/checkout POS, shared stock routing, multi gudang, receipt
digital + WA/email, pajak/Coretax, dan AI business analyst.

**Kebutuhan base yang dilayani non-modul.** "UI admin/operator" dan
"DB reliability" nyata tapi tidak dilayani modul terdaftar — masing-masing
hidup di `src/lib/ui/`+`src/layouts/` dan `src/lib/database/`. "Go-live
aman" dilayani `scripts/security-readiness.ts` yang **script-only &
ephemeral** (lihat catatan di bawah). Lihat
[`01_canvas_induk.md`](01_canvas_induk.md) §"Kapabilitas base yang BUKAN
modul terdaftar".

## Traceability — PRD → SRS → ERD → API → Issue → Test

> **Tabel NYATA, bukan ilustrasi** (sama seperti §"Business Need ke Modul"
> dan §"Matrix Modul vs Migration"). Setiap tabel, endpoint, dan ID issue
> di bawah diverifikasi ke sumbernya saat penulisan: nama tabel ke
> `CREATE TABLE` di `sql/`, path endpoint ke file rute di
> `src/pages/api/v1/`, dan ID issue ke heading di
> [`06_github_issues_detail.md`](06_github_issues_detail.md).
>
> **Yang dibuang (Issue #828 Temuan 2).** Versi sebelumnya punya 27 baris
> dan mayoritasnya tak bisa ditelusuri ke apa pun: 11 nama tabel fiktif
> (`awcms_mini_products`, `awcms_mini_sales_documents`,
> `awcms_mini_vat_invoices`, `awcms_mini_coretax_batches`,
> `awcms_mini_ai_tool_calls`, `awcms_mini_receipt_pdfs`,
> `awcms_mini_message_outbox`, `awcms_mini_checkout_sessions`,
> `awcms_mini_stock_balances`, `awcms_mini_warehouses`,
> `awcms_mini_db_pool_*`), 11+ endpoint fiktif (`/inventory/products`,
> `/sales/.../post`, `/crm/receipts/{id}/send`,
> `/tax/vat-invoices/generate`, `/ai/business-analyst/chat`,
> `/warehouses`, `/cycle-counts`, `/warehouse-transfers`,
> `/ui/navigation`, `/reports/sales/daily`, `/logs/recent`,
> `/profiles/resolve`, `/security/go-live-gates/evaluate`), dan **14 ID
> issue yang tak pernah ada di doc 06** (`3.1`-`3.4`, `4.1`/`4.3`/`4.4`,
> `5.1`-`5.3`, `7.3`/`7.4`, `8.2`, `9.2` — doc 06 hanya memuat 18 issue:
> `0.1`-`0.3`, `2.1`-`2.4`, `6.1`-`6.3`, `8.1`, `9.1`, `10.1`-`10.3`,
> `11.1`, `12.1`-`12.2`). Dua di antaranya (`/profiles/resolve` dan
> `awcms_mini_log_events`) bahkan tidak terdaftar di Issue #828 sendiri —
> ditemukan saat menyapu ulang setiap klaim tabel ini ke sumbernya.
>
> Kolom **Sprint** dihapus: penomoran sprint 1-12-nya mengacu rencana
> bootstrap asli yang sudah tuntas (lihat §Final coding instruction) dan
> tidak punya padanan untuk modul pasca-backlog yang dikerjakan per epic
> GitHub. Baris untuk modul pasca-backlog (`blog_content`, `news_portal`,
> `data_exchange`, dst.) sengaja **tidak** ditambahkan di sini — rantai
> issue-nya ada di §"Matrix Modul vs Migration" yang sudah memetakan tiap
> modul ke migration + epic-nya, dan menduplikasinya di sini hanya akan
> menciptakan salinan kedua yang bisa basi sendiri.

| Need               | Modul (`key`) / rumah                         | Tabel nyata                                                                     | API nyata                                                                 | Issue (doc 06) | Test            |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------- | --------------- |
| Setup tenant       | `tenant_admin`                                | `awcms_mini_tenants`, `awcms_mini_offices`                                      | `/setup/initialize`                                                       | 12.1           | setup test      |
| Login              | `identity_access`                             | `awcms_mini_identities`, `awcms_mini_tenant_users`                              | `/auth/login`, `/auth/me`, `/auth/logout`                                 | 2.3            | login test      |
| Access control     | `identity_access`                             | `awcms_mini_roles`, `awcms_mini_abac_policies`, `awcms_mini_abac_decision_logs` | `/access/evaluate`, `/access/decision-logs`                               | 2.4            | default deny    |
| Profile/party      | `profile_identity`                            | `awcms_mini_profiles` + tabel identifier/relationship                           | `/profiles`, `/profiles/{id}/identifiers`                                 | 2.2            | resolver        |
| Soft delete master | Shared + modul master                         | `deleted_at`, `deleted_by`                                                      | `/profiles/{id}/restore`, `/profiles/{id}/purge`                          | 0.1/0.3        | archive/restore |
| Sync               | `sync_storage`                                | `awcms_mini_sync_outbox`, `awcms_mini_sync_inbox`                               | `/sync/push`, `/sync/pull`                                                | 6.1            | HMAC            |
| Conflict           | `sync_storage`                                | `awcms_mini_sync_conflicts`                                                     | `/sync/conflicts/{id}/resolve`                                            | 6.2            | conflict        |
| Object queue R2    | `sync_storage`                                | `awcms_mini_object_sync_queue`                                                  | `/sync/object-queue`, `/sync/objects`                                     | 6.3            | object sync     |
| UI admin shell     | _(non-modul — `src/lib/ui/`, `src/layouts/`)_ | _(tak ada tabel)_                                                               | _(navigation dari `ModuleDescriptor.navigation`, bukan endpoint `/ui/*`)_ | 8.1            | render          |
| Reports            | `reporting`                                   | view laporan + `awcms_mini_reporting_projection_*`                              | `/reports/tenant-activity`, `/reports/access-audit`                       | 9.1            | tenant-aware    |
| Logs               | `logging`                                     | `awcms_mini_audit_events`                                                       | `/logs/audit`                                                             | 10.1           | redaction       |
| Pooling            | _(non-modul — `src/lib/database/`)_           | _(tak ada tabel)_                                                               | `/database/pool/health`                                                   | 10.2           | health/load     |
| Workflow           | `workflow`                                    | `awcms_mini_workflow_definitions`, `_instances`, `_tasks`, `_decisions`         | `/workflows/tasks/{id}/decisions`                                         | 11.1           | approval        |
| Go-live readiness  | _(non-modul — script)_                        | _(tak ada tabel — lihat catatan di bawah)_                                      | _(tak ada endpoint — `bun run security:readiness`)_                       | 10.3           | go-live gate    |

### Keputusan — production security readiness itu script-only & ephemeral

Issue #828 Temuan 4 menuntut keputusan eksplisit: **persist** security
finding (`awcms_mini_security_*` + endpoint
`/security/go-live-gates/evaluate`) **atau** nyatakan readiness sebagai
script-only. **Keputusan: script-only & ephemeral** — dokumen ini
sebelumnya menjanjikan tabel dan endpoint yang, saat diverifikasi,
**nol hit** di `sql/` maupun `src/` (`grep -r "awcms_mini_security_"` →
kosong). Janji itu dicabut, bukan diimplementasikan.

Yang **nyata** hari ini:

- `scripts/security-readiness.ts` (`bun run security:readiness`) —
  mengevaluasi gate dan **memblokir pada temuan critical**.
- Gate itu dijalankan sebagai bagian preflight produksi
  (`scripts/production-preflight.ts`), bukan lewat HTTP.
- Hasilnya **ephemeral**: exit code + output, tidak ada baris DB.

Konsekuensi yang harus disadari (dan **sengaja diterima** untuk saat ini):
tidak ada lifecycle temuan — tak ada triage, accept, waive, atau riwayat
siapa menerima risiko apa dan kapan. Bila lifecycle itu suatu saat
dibutuhkan, itu **modul/issue baru** dengan migration + endpoint +
ABAC + audit-nya sendiri, bukan sesuatu yang boleh diklaim dokumen ini
sudah ada. Catatan: `src/pages/admin/security.astro` **bukan** ini — itu
UI auth hardening (Issue #592).

## Matrix Modul vs Migration

Sumber: `docs/awcms-mini/repo-inventory.md` §Migrations (GENERATED via
`bun run repo:inventory:generate`) dan `src/modules/index.ts`, keduanya
dibaca ulang saat menulis tabel ini. **77 file migration nyata** di
`sql/` (`001`..`077`), dipetakan ke **23 modul terdaftar**
(`listBaseModules()`).

**Tabel ini di-gate.** `tests/unit/module-doc-reconciliation.test.ts`
mem-parse baris tabel di bawah dan menegakkan dua arah sekaligus: setiap
modul di `listBaseModules()` wajib punya baris, dan setiap file di `sql/`
wajib terpetakan tepat satu kali — tidak boleh ada migration yatim, nama
file fiktif, atau pemetaan ganda. Sebelum Issue #828 tabel ini berhenti di
`055` dan menghilangkan tujuh modul sementara preamble-nya sendiri
mengklaim mencakup semuanya; gate itulah yang membuat kondisi tersebut
tidak bisa terulang diam-diam.

Tabel ini menggantikan versi sebelumnya yang mengutip nama file fiktif (mis.
`003_awcms_mini_catalog_inventory_schema.sql`,
`004_awcms_mini_sales_pos_schema.sql`) dari sebuah sistem POS/retail yang
tidak pernah dibangun di repo base ini — berbeda dari tabel-tabel lain di
dokumen ini yang sengaja memakai domain retail/POS **ilustratif** (lihat
banner di puncak dokumen), tabel ini secara spesifik mendokumentasikan
struktur repo NYATA, sehingga mengikuti data real, bukan ilustrasi.

| Modul (`key`)                | Migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _(Foundation, lintas-modul)_ | `001_awcms_mini_foundation_schema.sql`, `013_awcms_mini_enforce_rls_least_privilege.sql`, `045_awcms_mini_db_role_separation.sql`, `077_awcms_mini_performance_missing_indexes.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tenant_admin`               | `002_awcms_mini_tenant_office_schema.sql`, `006_awcms_mini_setup_wizard_schema.sql`, `015_awcms_mini_tenant_settings_management_permission_schema.sql`, `016_awcms_mini_tenant_default_locale_english_schema.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `profile_identity`           | `003_awcms_mini_central_profile_management_schema.sql`, `059_awcms_mini_profile_identity_party_lifecycle_schema.sql` (Issue #748, epic #738 Wave 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `identity_access`            | `004_awcms_mini_identity_login_schema.sql`, `005_awcms_mini_abac_access_control_schema.sql`, `022_awcms_mini_password_reset_schema.sql`, `034_awcms_mini_mfa_totp_schema.sql`, `035_awcms_mini_google_oidc_schema.sql`, `036_awcms_mini_tenant_oidc_sso_schema.sql`, `037_awcms_mini_tenant_oidc_sso_permissions.sql`, `061_awcms_mini_business_scope_assignments_schema.sql`, `062_awcms_mini_business_scope_permissions.sql` (Issue #746, epic #738 Wave 2 — business scope/SoD, eksplisit "owned by `identity_access`"), `083_awcms_mini_abac_policy_dsl_schema.sql`, `084_awcms_mini_abac_policy_admin_permissions.sql` (Issue #179, epic #177 — dynamic ABAC policy evaluator: DSL AST jsonb, precedence fail-closed, cache per-tenant, ADR-0023) |
| `sync_storage`               | `007_awcms_mini_sync_storage_outbox_inbox_schema.sql`, `008_awcms_mini_sync_storage_conflict_schema.sql`, `009_awcms_mini_object_sync_queue_schema.sql`, `014_awcms_mini_sync_node_management_permission_schema.sql`, `017_awcms_mini_sync_queue_conflict_performance_indexes.sql`, `018_awcms_mini_object_sync_queue_dispatcher_schema.sql`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `reporting`                  | `010_awcms_mini_management_reporting_permission_schema.sql`, `069_awcms_mini_reporting_projections_schema.sql`, `070_awcms_mini_reporting_projections_permissions.sql` (Issue #753, epic #738 Wave 3 — reporting projection registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `logging`                    | `011_awcms_mini_audit_logging_schema.sql`, `047_awcms_mini_observability_metrics_permission.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `workflow`                   | `012_awcms_mini_workflow_approval_schema.sql`, `060_awcms_mini_workflow_managed_definitions_schema.sql` (Issue #747, epic #738 Wave 2 — managed/versioned definitions), `078_awcms_mini_workflow_decisions_one_per_decider_unique.sql` (Issue #851, epic #818 — quorum-`all` TOCTOU: satu suara ordinari per decider per task). Key terdaftar `workflow`, walau direktorinya `src/modules/workflow-approval`                                                                                                                                                                                                                                                                                                                                           |
| `form_drafts`                | `019_awcms_mini_form_drafts_schema.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `email`                      | `020_awcms_mini_email_schema.sql`, `021_awcms_mini_email_template_i18n_schema.sql`, `023_awcms_mini_email_announcement_permission_schema.sql`, `024_awcms_mini_email_message_cancel_permission_schema.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `module_management`          | `025_awcms_mini_module_management_schema.sql` (epic #510, Issue #511-#521)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `blog_content`               | `026_awcms_mini_blog_content_schema.sql`, `027_awcms_mini_blog_content_permissions.sql`, `028_awcms_mini_blog_content_search_vector.sql`, `029_awcms_mini_blog_content_presentation_schema.sql`, `030_awcms_mini_blog_content_presentation_permissions.sql`, `050_awcms_mini_blog_posts_seo_image.sql`, `051_awcms_mini_blog_content_internal_tag_links_schema.sql`, `052_awcms_mini_blog_content_internal_tag_links_permissions.sql` (epic #536, Issue #537-#543 + follow-ups)                                                                                                                                                                                                                                                                        |
| `tenant_domain`              | `031_awcms_mini_tenant_domain_schema.sql`, `032_awcms_mini_tenant_domain_permissions.sql`, `033_awcms_mini_tenant_domain_lookup_function.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `visitor_analytics`          | `038_awcms_mini_visitor_analytics_permissions.sql`, `039_awcms_mini_visitor_analytics_schema.sql`, `040_awcms_mini_visitor_analytics_session_lookup_index.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `news_portal`                | `041_awcms_mini_news_media_object_registry_schema.sql`, `042_awcms_mini_news_media_permissions.sql`, `043_awcms_mini_news_portal_tenant_state_schema.sql`, `044_awcms_mini_news_portal_homepage_sections_schema.sql`, `046_awcms_mini_news_media_orphan_lifecycle.sql`, `049_awcms_mini_news_portal_ad_placements_schema.sql`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `idn_admin_regions`          | `048_awcms_mini_idn_admin_regions_permissions.sql`, `054_awcms_mini_idn_admin_regions_schema.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `social_publishing`          | `053_awcms_mini_social_publishing_schema.sql`, `055_awcms_mini_social_publishing_verify_permission.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `data_lifecycle`             | `057_awcms_mini_data_lifecycle_schema.sql`, `058_awcms_mini_data_lifecycle_permissions.sql` (Issue #745, epic #738 Wave 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `domain_event_runtime`       | `056_awcms_mini_domain_event_runtime_schema.sql` (Issue #742, epic #738 Wave 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `organization_structure`     | `063_awcms_mini_organization_structure_schema.sql`, `064_awcms_mini_organization_structure_permissions.sql`, `065_awcms_mini_organization_structure_assignment_unique_index.sql` (Issue #749, epic #738 Wave 2, ADR-0016)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `document_infrastructure`    | `066_awcms_mini_document_infrastructure_schema.sql`, `067_awcms_mini_document_infrastructure_permissions.sql`, `068_awcms_mini_document_infrastructure_confidentiality_permissions.sql` (Issue #751, epic #738 Wave 3, ADR-0017)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `data_exchange`              | `071_awcms_mini_data_exchange_schema.sql`, `072_awcms_mini_data_exchange_permissions.sql` (Issue #752, epic #738 Wave 3, ADR-0018)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `integration_hub`            | `073_awcms_mini_integration_hub_schema.sql`, `074_awcms_mini_integration_hub_permissions.sql` (Issue #754, epic #738 Wave 3, ADR-0019)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reference_data`             | `075_awcms_mini_reference_data_schema.sql`, `076_awcms_mini_reference_data_permissions.sql` (Issue #750, epic #738 Wave 3, ADR-0021)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `service_catalog`            | `079_awcms_mini_service_catalog_schema.sql`, `080_awcms_mini_service_catalog_permissions.sql` (Issue #870, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tenant_entitlement`         | `081_awcms_mini_tenant_entitlement_schema.sql`, `082_awcms_mini_tenant_entitlement_permissions.sql` (Issue #871, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tenant_provisioning`        | `085_awcms_mini_tenant_provisioning_schema.sql`, `086_awcms_mini_tenant_provisioning_permissions.sql` (Issue #872, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `usage_metering`             | `087_awcms_mini_usage_metering_schema.sql`, `088_awcms_mini_usage_metering_permissions.sql` (Issue #875, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tenant_lifecycle`           | `089_awcms_mini_tenant_lifecycle_schema.sql`, `090_awcms_mini_tenant_lifecycle_permissions.sql` (Issue #873, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `subscription_billing`       | `091_awcms_mini_subscription_billing_schema.sql`, `092_awcms_mini_subscription_billing_permissions.sql` (Issue #876, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `payment_gateway`            | `093_awcms_mini_payment_gateway_schema.sql`, `094_awcms_mini_payment_gateway_permissions.sql` (Issue #877, epic #868 SaaS control plane Wave 1, ADR-0022)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Empat migration di baris "Foundation, lintas-modul" tidak dipetakan ke
satu modul karena sifatnya benar-benar lintas-modul: `001` adalah
bootstrap murni (ledger migrasi + extension Postgres, sebelum modul
apa pun terdaftar); `013` dan `045` adalah hardening keamanan
lintas-tabel (RLS enforcement, pemisahan role DB least-privilege) yang
menyentuh tabel banyak modul sekaligus, bukan schema satu modul — lihat
`docs/awcms-mini/20_threat_model_security_architecture.md`. `077` (Issue
#830, epic #818) adalah index tambahan Tier A murni-DDL yang menyentuh
tabel milik empat modul berbeda sekaligus (`identity_access`,
`blog_content`, `sync_storage`, `visitor_analytics`), sehingga tidak bisa
diatribusikan ke satu pemilik.

## Matrix Modul vs Security Control

| Control               | Modul                                                          |
| --------------------- | -------------------------------------------------------------- |
| No hardcoded secrets  | Semua                                                          |
| Password hashing      | Identity                                                       |
| Tenant isolation      | Semua tenant-scoped                                            |
| RBAC/ABAC             | Identity Access                                                |
| RLS                   | Semua tenant-scoped                                            |
| Audit log             | Observability + semua high-risk                                |
| Idempotency           | POS, Warehouse, Tax, CRM, Sync, Workflow                       |
| Soft delete           | Master/config/draft tenant-scoped; restore/purge by permission |
| Input validation      | Semua API                                                      |
| Sensitive masking     | Profile, CRM, Tax, Logs, AI                                    |
| Stock lock            | Inventory, POS, Warehouse                                      |
| Immutable transaction | Sales POS                                                      |
| Sync HMAC             | Sync                                                           |
| File checksum         | Sync/R2, Tax export                                            |
| Consent               | CRM                                                            |
| AI read-only          | AI Analyst                                                     |
| Tax export approval   | Tax + Workflow                                                 |
| Go-live gate          | Production Security                                            |
| Backup/restore        | Deployment/Ops                                                 |

## Matrix Security Control vs Skill

| Control                                      | Skill penegak                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tenant isolation + RBAC/ABAC + RLS           | `awcms-mini-abac-guard`                                                                                |
| Idempotency high-risk                        | `awcms-mini-idempotency`                                                                               |
| Audit log high-risk                          | `awcms-mini-audit-log`                                                                                 |
| Sensitive masking                            | `awcms-mini-sensitive-data`                                                                            |
| Sync HMAC + file checksum                    | `awcms-mini-sync-hmac`                                                                                 |
| Migration aman (RLS/index)                   | `awcms-mini-new-migration`                                                                             |
| Soft delete policy                           | `awcms-mini-new-migration`, `awcms-mini-new-endpoint`, `awcms-mini-abac-guard`, `awcms-mini-audit-log` |
| API/event contract                           | `awcms-mini-new-endpoint`, `awcms-mini-new-event`                                                      |
| Testing berlapis                             | `awcms-mini-testing`                                                                                   |
| Review keamanan                              | `awcms-mini-security-review` + agent `awcms-mini-security-auditor`                                     |
| Triase CodeQL code scanning                  | `awcms-mini-codeql-triage`                                                                             |
| Review PR / DoD                              | `awcms-mini-pr-review` + agent `awcms-mini-reviewer`                                                   |
| Go-live gate                                 | `awcms-mini-production-preflight`                                                                      |
| Profil deployment (LAN-first/Coolify)        | `awcms-mini-deploy`                                                                                    |
| UI/design system/a11y                        | `awcms-mini-ui-screen`                                                                                 |
| Form multi-step (wizard)                     | `awcms-mini-wizard-form`                                                                               |
| Server-side draft persistence                | `awcms-mini-form-drafts`                                                                               |
| Kirim email transaksional                    | `awcms-mini-email`                                                                                     |
| Kelola sistem Module Management              | `awcms-mini-module-management` (+ `awcms-mini-new-module` untuk scaffold field descriptor)             |
| Kerjakan epic blog_content (Issue #537-#543) | `awcms-mini-blog-content`                                                                              |
| Rilis/CHANGELOG                              | `awcms-mini-release`                                                                                   |
| Legacy migration                             | `awcms-mini-legacy-migration`                                                                          |
| Implementasi issue                           | skill `awcms-mini-implement-issue` + agent `awcms-mini-coder`                                          |
| Snapshot docs GitHub                         | `awcms-mini-github-snapshot`                                                                           |

## Matrix Modul vs SOP

| SOP                   | Modul utama                    |
| --------------------- | ------------------------------ |
| Instalasi awal        | Deployment/Foundation          |
| Setup tenant          | Tenant Admin                   |
| Tambah user/role      | Identity + Profile             |
| Input produk          | Inventory                      |
| Input stok awal       | Inventory/Warehouse            |
| Transaksi operasional | Sales POS                      |
| Cancel/retur          | Sales POS + Workflow           |
| Warehouse transfer    | Warehouse                      |
| Cycle count           | Warehouse                      |
| Stock adjustment      | Inventory/Warehouse + Workflow |
| Receipt WA/email      | CRM                            |
| Customer portal       | CRM/UI                         |
| Offline sync          | Sync                           |
| Pajak/Coretax         | Accounting Tax                 |
| Reporting             | Reporting                      |
| AI Analyst            | AI                             |
| Backup/restore        | Deployment/Database            |
| Troubleshooting       | Observability/DB               |
| Manajemen modul       | Module Management (epic #510)  |
| Blog/konten           | Blog Content (epic #536)       |
| Handover              | Semua                          |

## Matrix kesiapan implementasi

Kelengkapan dokumen per kebutuhan implementasi. "Design/spec ready" = cukup untuk mulai koding; DDL penuh & schema OpenAPI penuh sengaja diproduksi per-migration/per-endpoint saat implementasi (bukan pra-tulis).

| Kebutuhan                                   | Dokumen           | Status                                    |
| ------------------------------------------- | ----------------- | ----------------------------------------- |
| Arsitektur & fase                           | 01                | Ready                                     |
| Kebutuhan produk & teknis                   | 02, 03            | Ready                                     |
| ERD & data dictionary                       | 04                | Ready (ringkas; DDL penuh per-migration)  |
| Kontrak API/event                           | 05                | Ready (daftar; schema penuh per-endpoint) |
| Issue, sprint, testing                      | 06, 07            | Ready                                     |
| SOP operasional                             | 08                | Ready                                     |
| Roadmap, coding standard, blueprint, prompt | 09–12             | Ready                                     |
| **UI/UX design system & layar**             | 14                | Ready                                     |
| **Frontend & integrasi (offline-first)**    | 15                | Ready                                     |
| **Backend data access & DB integrasi**      | 16                | Ready                                     |
| **Seed, RBAC, ABAC policy**                 | 17                | Ready                                     |
| **Konfigurasi & environment**               | 18                | Ready                                     |
| Skill proyek                                | `.claude/skills/` | Ready                                     |

Diproduksi saat implementasi (bukan pra-tulis): DDL lengkap tiap tabel (via migration), schema request/response penuh tiap endpoint (via OpenAPI), string i18n aktual, dan aset UI final.

## Implementation start recommendation

Urutan coding paling aman:

1. Issue 0.1 — Repository skeleton.
2. Issue 0.2 — SQL migration runner.
3. Issue 0.3 — OpenAPI/AsyncAPI baseline.
4. Issue 12.1 — Initial setup wizard API.
5. Issue 2.1 — Tenant and office schema.
6. Issue 2.2 — Central profile schema.
7. Issue 2.3 — Identity login.
8. Issue 2.4 — RBAC/ABAC.
9. Issue 3.1 — Product catalog.
10. Issue 3.2 — Stock balance/movement.
11. Issue 3.3 — Checkout/cart.
12. Issue 3.4 — Atomic transaction posting.

Alasan:

- Aplikasi domain tidak aman tanpa tenant/auth/profile/access.
- Transaksi tidak boleh sebelum idempotency dan stock lock.
- Provider eksternal tidak boleh didahulukan.
- AI menunggu reporting safe views.
- Coretax menunggu sales posted dan tax profile.

## Minimal MVP Boundary

| Area               | Minimum                                        |
| ------------------ | ---------------------------------------------- |
| Tenant             | tenant, office, setup locked                   |
| Auth               | owner/admin/operator login                     |
| Access             | role dasar, ABAC default deny                  |
| Profile            | customer profile resolver                      |
| Product            | create/list/search product                     |
| Stock              | balance, movement                              |
| POS                | checkout, cart, payment, post                  |
| Transaction safety | idempotency, stock lock, rollback              |
| Receipt            | PDF local                                      |
| Audit              | transaction audit                              |
| Backup             | pg_dump + restore tested                       |
| Docs               | admin/operator SOP basic                       |
| Soft delete        | master data hidden by default, restore audited |

## Production-ready Boundary

- MVP usable selesai.
- RLS aktif dan diuji.
- ABAC default deny diuji.
- Audit high-risk aktif.
- Soft delete/restore/purge policy aktif untuk resource deletable.
- No critical security finding.
- Backup restore tested.
- Pool health OK.
- POS concurrent test OK.
- Receipt token aman.
- Sync conflict policy tested jika hybrid.
- Tax masking aktif jika modul tax aktif.
- CRM opt-out respected jika CRM aktif.
- AI read-only jika AI aktif.
- SOP dan handover selesai.

## Repository artifact checklist

### Root

- `AGENTS.md`
- `README.md`
- `CHANGELOG.md` + `.changeset/` (versioning via Changesets)
- `.claude/skills/` (50 skill proyek + katalog README)
- `.claude/agents/` (3 subagent: coder, reviewer, security-auditor)
- `package.json`
- `astro.config.mjs`
- `tsconfig.json`
- `.env.example`
- `.gitignore`
- `docker-compose.yml`

### Folder standar

Tiap folder standar menyertakan `README.md` sebagai kontrak isi/aturan folder:

- `src/lib/README.md` — helper lintas-modul (`auth/`, `database/`, `errors/`, `files/`, `logging/`).
- `src/modules/_shared/README.md` — module contract, API response envelope, konvensi soft delete.
- `openapi/README.md` — kontrak OpenAPI publik dan kewajiban `api:spec:check`.
- `asyncapi/README.md` — kontrak AsyncAPI domain-event dan kewajiban pendaftaran channel.
- `deploy/README.md` — deployment profile (systemd, container, PgBouncer, backup) — Bun-only.
- `fixtures/README.md` — data uji sintetis; larangan data customer/dump/secret asli.

### Source modules

23 modul terdaftar nyata di `src/modules/index.ts` (`ls -d src/modules/*/`,
dikonfirmasi `bun run modules:dag:check` — "23 registered modules"),
menggantikan daftar fiktif sebelumnya (`catalog-inventory`, `sales-pos`,
`warehouse-management`, `accounting-tax`, `crm-communication`,
`ai-analyst`, `observability-logging`, `database-connectivity`,
`ui-experience`, `production-security-readiness` — tidak satu pun folder
ini pernah ada di repo base):

- `_shared` (bukan modul terdaftar — kontrak/helper lintas-modul)
- blog-content
- data-exchange
- data-lifecycle
- document-infrastructure
- domain-event-runtime
- email
- form-drafts
- identity-access
- idn-admin-regions
- integration-hub
- logging
- module-management
- news-portal
- organization-structure
- profile-identity
- reference-data
- reporting
- social-publishing
- sync-storage
- tenant-admin
- tenant-domain
- visitor-analytics
- workflow-approval

### Docs

Semua file `docs/awcms-mini/01` sampai `19` harus menjadi acuan sebelum coding. Dokumen `14`–`18` (UI/UX, frontend, backend/DB, seed/RBAC/ABAC, konfigurasi) melengkapi kesiapan implementasi; `19` adalah glossary rujukan istilah. Snapshot issue GitHub aktual ada di `docs/awcms-mini/github/` dan wajib direfresh bila state issue berubah.

## Final coding instruction

> **Catatan status (base selesai).** Urutan bootstrap di bawah adalah rencana asli membangun base generik dari nol dan seluruhnya sudah tuntas (18 issue backlog doc 06 + peningkatan M9) — arsip, bukan pekerjaan baru. Untuk kontribusi baru lihat [`../../AGENTS.md`](../../AGENTS.md) §Mulai dari sini dan [`README.md`](README.md) §Langkah berikutnya. Versi rilis saat ini **sengaja tidak ditulis di sini**: sumber kebenarannya `package.json` + [`../../CHANGELOG.md`](../../CHANGELOG.md). Sebelum Issue #828 baris ini mengklaim "v0.23.5" sementara `package.json` sudah di v0.24.0 — angka versi yang disalin ke prosa dokumen selalu basi satu rilis kemudian.

```text
Mulai dari Issue 0.1.
Jangan lompat ke POS sebelum foundation, tenant, profile, auth, dan ABAC selesai.
Jangan integrasi provider eksternal sebelum core POS aman.
Jangan integrasi AI sebelum reporting safe views siap.
Jangan mengaktifkan production sebelum security readiness pass.
Jangan commit secret, dump database, data customer asli, atau .env.
```

## Penutup

Rantai implementasi AWCMS-Mini lengkap:

```text
Business Need
→ PRD
→ SRS
→ ERD/Data Dictionary
→ OpenAPI/AsyncAPI
→ GitHub Issues
→ GitHub Snapshot
→ Sprint Plan
→ SOP/User Guide
→ Repository Roadmap
→ Coding Standard
→ Implementation Blueprint
→ Generator Prompt
→ Traceability Matrix
→ Ready for Coding
```

```mermaid
flowchart TB
  BN[Business Need] --> PRD[PRD] --> SRS[SRS] --> ERD[ERD/Data Dictionary]
  ERD --> API[OpenAPI/AsyncAPI] --> ISS[GitHub Issues] --> GHS[GitHub Snapshot] --> SPR[Sprint Plan]
  SPR --> SOP[SOP/User Guide] --> RR[Repository Roadmap] --> CS[Coding Standard]
  CS --> BP[Implementation Blueprint] --> GP[Generator Prompt] --> TM[Traceability Matrix]
  TM --> RC([Ready for Coding])
```
