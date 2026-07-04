# Bagian 13 — Master Index dan Traceability

## Master index

| Artefak             | Lokasi                             |
| ------------------- | ---------------------------------- |
| Kontrak kerja agent | `AGENTS.md`                        |
| Paket dokumen 01–19 | `docs/awcms-mini/`                 |
| Helper standar      | `src/modules/_shared/`, `src/lib/` |
| Registry modul      | `src/modules/index.ts`             |
| Schema + RLS        | `sql/001–004`                      |
| Kontrak API/event   | `openapi/`, `asyncapi/`            |
| Scripts validasi    | `scripts/`                         |
| Test                | `tests/`                           |
| Skill proyek        | `.claude/skills/`                  |
| Subagents           | `.claude/agents/`                  |
| Deploy profile      | `deploy/`                          |

## Traceability requirement → implementasi → verifikasi

| Requirement (doc)                   | Implementasi                                                                              | Verifikasi                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Envelope response standard (05)     | `_shared/api-response.ts`                                                                 | `tests/shared/api-response.test.ts`                          |
| Error code standard (03/05)         | `_shared/api-error.ts`                                                                    | idem + spec check                                            |
| Validasi input (10)                 | `_shared/validation.ts`                                                                   | `tests/shared/validation.test.ts`                            |
| Idempotency high-risk (10/16)       | `_shared/idempotency.ts` + `lib/database/idempotency-store.ts` + `awcms_idempotency_keys` | `tests/shared/idempotency.test.ts`                           |
| ABAC default deny (10/17)           | `_shared/access.ts` (`guardAccess`)                                                       | `tests/shared/audit-and-events.test.ts`                      |
| Audit + redaction (10)              | `_shared/audit.ts` + `lib/logging/redact.ts`                                              | idem + `tests/lib/redact.test.ts`                            |
| Domain event envelope (05/10)       | `_shared/domain-event.ts`                                                                 | `tests/shared/audit-and-events.test.ts`                      |
| Module contract + registry (10/11)  | `_shared/module-contract.ts`, `modules/index.ts`                                          | `tests/modules/registry.test.ts`                             |
| Tenant RLS `SET LOCAL` (04/16)      | `lib/database/transaction.ts` (`withTenant`) + policy FORCE di sql/                       | Uji isolasi RLS (doc 07) + `security:readiness` RLS coverage |
| Migration berurutan + checksum (16) | `lib/database/migrations.ts` + `scripts/db-migrate.ts`                                    | `tests/lib/migrations.test.ts` + run nyata                   |
| Konfigurasi fail-fast (18)          | `lib/config.ts`                                                                           | `tests/lib/config.test.ts`                                   |
| Logger redaction (10)               | `lib/logging/logger.ts`                                                                   | `tests/lib/redact.test.ts`                                   |
| Password aman (04)                  | `lib/auth/passwords.ts` (scrypt)                                                          | `tests/lib/passwords-and-i18n.test.ts`                       |
| Session token (03)                  | `lib/auth/session.ts` (jose HS256)                                                        | dipakai Sprint 2 (test menyusul)                             |
| i18n id/en/ms/ar (14)               | `lib/i18n/`                                                                               | `tests/lib/passwords-and-i18n.test.ts`                       |
| Kontrak ↔ modul konsisten (05)      | `scripts/api-spec-check.ts`                                                               | jalankan `api:spec:check`                                    |
| Security readiness gates (07)       | `scripts/security-readiness.ts`                                                           | jalankan `security:readiness`                                |
| Pre-deploy checklist (09)           | `scripts/production-preflight.ts`                                                         | jalankan `production:preflight`                              |

## Checklist final base v0.1.0 (Foundation)

- [x] Struktur repo sesuai doc 09.
- [x] Module contract + registry tervalidasi.
- [x] Helper `_shared` + `lib` lengkap dan teruji (46 unit test).
- [x] Migration 001–004 apply/idempotent/status OK; RLS isolation terbukti.
- [x] OpenAPI/AsyncAPI baseline + spec check pass.
- [x] Health + pool health endpoint; contract test pass.
- [x] `security:readiness` pass; `production:preflight` tersedia.
- [x] Paket dokumen 01–19 + AGENTS.md + skill + subagents.
- [ ] Sprint 2–6 (lihat doc 06/11) — belum diimplementasi, by design (skeleton-first).

## Aturan sinkronisasi

Dokumen, kode, migration, kontrak, dan skill harus berubah **bersama**. Bila standar berubah: perbarui doc terkait + helper `_shared`/`lib` + skill `.claude/skills/` dalam PR yang sama.
