---
"awcms-mini": minor
---

Refaktor total ke standar AWCMS-Mini modular monolith (mengikuti paket dokumen AWPOS): skeleton Bun + Astro + PostgreSQL, module contract + registry, helper `_shared` (response/error/tenant-context/ABAC/audit/domain-event/idempotency/validasi), `src/lib` (config, logging redaction, database pool + `withTenant` RLS, transaction wrapper), SQL migration runner berurutan + checksum, migration 001–004 (foundation, tenant/identity/profile, access control, observability), baseline OpenAPI/AsyncAPI + spec check, health endpoint, skrip readiness/preflight, paket dokumen 01–19, skill & subagent proyek, profil deploy. Implementasi legacy (Hono + emdash + plugin ADR-018) dihapus — tersimpan di branch `legacy/pre-awpos-standard`.
