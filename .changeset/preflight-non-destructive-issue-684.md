---
"awcms-mini": minor
---

Make `bun run production:preflight` non-destructive by default (Issue #684, epic #679, platform-hardening).

`db:migrate` previously ran as an early, unconditional stage — a later stage failing (spec check, tests, build) still left the target database migrated, even though the preflight's own final verdict was "GO-LIVE DIBLOKIR". `bun run production:preflight` is now entirely read-only: `config:validate`, `security:readiness`, a new `db:connectivity` check (confirms the database is reachable via a single `SELECT`, never a write), `api:spec:check`, `test`, `build`, `db:pool:health` (now blocks go-live if skipped when `APP_ENV=production`, rather than silently passing), and a new `migration:plan` dry-run stage that reports exactly which migrations are pending without applying them.

Applying migrations is now a separate, explicit, gated action: `--apply-migrations --backup-verified --acknowledge-target=<APP_ENV value>`. All three flags are required together, the apply step only runs if every read-only stage passed, and `--acknowledge-target` must match `APP_ENV` exactly (a typo-catcher against accidentally targeting the wrong environment). `--json-output=<path>` optionally writes a structured `{ go, results, plan, applied }` result for deploy-evidence retention.

New runbook (`docs/awcms-mini/production-preflight-runbook.md`) documents the full staging-rehearsal → backup-evidence → apply → rollback procedure.
