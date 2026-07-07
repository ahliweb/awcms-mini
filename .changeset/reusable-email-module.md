---
"awcms-mini": minor
---

Add a reusable, provider-neutral email module (epic #492, Issues
#493-#500): message/recipient DTOs, an `EmailProvider` port with a real
Mailketing adapter, a tenant-scoped schema/RLS/delivery queue
(`sql/020`-`024`), a claim/send/finalize dispatcher (`bun run
email:dispatch`, circuit breaker, retry/backoff), template management
(CRUD, soft-delete/restore, i18n locale variants, per-category variable
allowlists, admin preview), password reset
(`POST /api/v1/auth/password/{forgot,reset}`, enumeration-safe), bulk
announcement/notification workflows
(`POST /api/v1/email/announcements[/preview]`, tenant/role/explicit-user
targeting with two-tier ABAC, idempotent), and admin
observability/ops (`GET /api/v1/email/messages` + cancel,
`GET/POST/DELETE /api/v1/email/suppressions`, `GET
/api/v1/reports/email-health`, a `security:readiness` provider-config
gate). Generic infrastructure — analogous to `sync_storage`'s
object-storage port — for password reset, system announcements, and
workflow notifications; not a domain-specific "send a receipt" feature.
See `src/modules/email/README.md`.
