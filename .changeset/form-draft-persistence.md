---
"awcms-mini": minor
---

Add generic server-side form draft persistence: a new
`awcms_mini_form_drafts` table (tenant-scoped, RLS FORCE'd) and
`src/modules/form-drafts/` module with `GET/POST /api/v1/form-drafts`,
`GET/PATCH/DELETE /api/v1/form-drafts/{id}`, and
`POST /api/v1/form-drafts/{id}/submit` (Idempotency-Key required). Lets a
multi-step wizard (Issue #479/#480) resume across sessions/devices instead
of only holding progress in memory. Payload is denylist-validated against
secret-shaped fields (password/token/secret/credential/apiKey/privateKey)
and capped at 32KB; a scheduled `bun run form-drafts:purge` expires
overdue drafts and purges old expired/abandoned ones. Piloted in
`admin/examples/wizard.astro` — no domain-specific behavior added to the
base itself. See `src/modules/form-drafts/README.md` and
`docs/awcms-mini/examples/wizard-form-pattern.md` §Server-side draft
(Issue #484).
