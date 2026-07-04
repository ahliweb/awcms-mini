# Bagian 19 — Glossary dan Terminologi

| Istilah                  | Definisi                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| **Base**                 | Repo awcms-mini ini — lapisan reusable standar untuk semua aplikasi AhliWeb                       |
| **Aplikasi domain**      | Aplikasi turunan di atas base (contoh: AWPOS) yang menambah modul bisnisnya                       |
| **Modular monolith**     | Satu deployable dengan modul berbatas tegas (`module.ts` + domain/application/infrastructure/api) |
| **Module descriptor**    | Metadata modul (`ModuleDescriptor`): key, dependencies, kontrak API/event                         |
| **Module registry**      | `src/modules/index.ts` — daftar modul aktif + validasi dependency                                 |
| **`_shared`**            | Module contract layer: helper standar lintas modul (response, error, guard, audit, dsb.)          |
| **Tenant**               | Unit kepemilikan data (`awcms_tenants`); semua data bisnis ter-scope tenant                       |
| **Office**               | Unit kerja hierarkis milik tenant (head_office/branch/store/warehouse/other)                      |
| **Tenant context**       | Identitas request tervalidasi (`TenantContext`) dari auth middleware                              |
| **RBAC**                 | Role-based access: role per tenant → permission `module.activity.action`                          |
| **ABAC**                 | Attribute-based access: policy allow/deny beratribut; default deny; deny overrides allow          |
| **Decision log**         | Catatan keputusan akses (deny high-risk wajib) — `awcms_abac_decision_logs`                       |
| **RLS**                  | Row Level Security PostgreSQL; policy `tenant_id = app.current_tenant_id`, ENABLE+FORCE           |
| **`withTenant`**         | Transaction wrapper yang men-set RLS context via `set_config(..., true)` (SET LOCAL)              |
| **Idempotency-Key**      | Header wajib mutation high-risk; key+hash sama → replay; hash beda → 409                          |
| **High-risk action**     | Aksi yang wajib idempotency dan/atau audit (setup, assignment, approval, resolve/merge, sync)     |
| **Audit event**          | Jejak aksi high-risk (`awcms_audit_events`), attributes ter-redact, tenant-scoped                 |
| **Redaction**            | Penggantian nilai key sensitif dengan `[REDACTED]` sebelum log/audit                              |
| **Masked value**         | Representasi tampilan identifier sensitif; nilai mentah tidak disimpan                            |
| **Value hash**           | Hash identifier untuk lookup/dedup tanpa menyimpan nilai mentah                                   |
| **Central profile**      | Profil kanonik orang/organisasi per tenant (`awcms_profiles`)                                     |
| **Domain event**         | Event antar modul ber-envelope standard, terdaftar di AsyncAPI                                    |
| **Transactional outbox** | Event/pesan ditulis satu transaction dengan mutation, dikirim worker terpisah                     |
| **Work class**           | Kelas prioritas koneksi DB (critical/interactive/reporting/background/maintenance)                |
| **Backpressure**         | Penolakan terkendali saat jenuh — antrean, timeout, `503 DATABASE_BUSY`                           |
| **Migration ledger**     | `awcms_schema_migrations` — nama + checksum migration yang sudah applied                          |
| **Checksum drift**       | File migration applied berubah — error; koreksi = migration baru                                  |
| **Setup wizard**         | Inisialisasi sekali jalan: tenant + owner + seed default, lalu terkunci                           |
| **Go-live gate**         | Syarat produksi (doc 07); critical finding = BLOCKED                                              |
| **Changeset**            | Entri versioning per PR (`bun run changeset`) — dasar bump SemVer + CHANGELOG                     |
| **Skill proyek**         | Instruksi Claude Code di `.claude/skills/` yang meng-encode standar dokumen                       |
| **Subagent**             | Agent terdefinisi di `.claude/agents/` (coder/reviewer/security-auditor)                          |
| **Skeleton-first**       | Modul dibuat sebagai kerangka ber-TODO (status `experimental`) — tanpa fake completion            |
| **Offline-first**        | Aplikasi berfungsi tanpa internet; sync/provider bersifat opsional non-blocking                   |
