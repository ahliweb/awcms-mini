---
"awcms-mini": minor
---

Add a typed configuration registry and a new CI drift gate, and mark six
dead/misleading environment variables deprecated (Issue #689, epic #679
platform-hardening).

`src/lib/config/registry.ts` is now the single structured source of truth
(TypeScript, not JSON — full type-checking) for every environment
variable this repo's application/deployment tooling reads: one entry per
variable with `type`, `required` (`required`/`optional`/`conditional` —
mirroring `scripts/validate-env.ts`'s actual boot-time enforcement),
`ownerModule`, `sensitivity` (`secret`/`non-secret`), `profiles`
(development/staging/production/offline-lan), `default`, and an optional
`deprecated` marker (`since`/`removalVersion`/`guidance`). The ~30
existing `checkXxxConfig` functions in `scripts/validate-env.ts` are
unchanged (same tested pass/fail behavior, same 81 existing tests still
pass) — the registry is a purely additive metadata layer, cross-referenced
via each entry's `validatorGroup` rather than wired as a risky
circular-import refactor.

`bun run config:docs:check` (`scripts/config-docs-check.ts`, now part of
`bun run check`) enforces three-way parity between the registry,
`.env.example`, and `docs/awcms-mini/18_configuration_env_reference.md` —
failing CI when a variable exists in one surface but not the others,
except for explicit, reasoned exemptions (`CONFIG_EXEMPTIONS` in the
registry for illustrative example content like `STARSENDER_*`/
`AI_ANALYST_*`/platform-level `NODE_ENV`/`PORT`; `DOC18_NON_VARIABLE_TOKENS`
in the script for prose false positives like quoted SQL keywords). This
gate already caught and fixed two real drift instances found during this
issue's audit: `FORM_DRAFT_RETENTION_DAYS` was documented in doc 18 but
missing from the real `.env.example`, and `AWCMS_MINI_APP_DB_PASSWORD` was
in `.env.example` but never mentioned in doc 18 at all.

Six variables are now marked `deprecated` (verified dead via exhaustive
grep, not assumed from a description) with migration guidance and a
`1.0.0` target removal version — `config:validate`'s boot-time pass/fail
behavior is unchanged for this release (`AUTH_JWT_SECRET`/`APP_TIMEZONE`
remain required, non-breaking for every existing deployment); a new
informational-only "deprecation notices" section is appended to
`config:validate`'s CLI report when a deprecated variable is currently
set:

- `AUTH_JWT_SECRET` — sessions are opaque tokens
  (`awcms_mini_sessions.token_hash`), never JWT; no code signs or verifies
  anything with this value.
- `APP_TIMEZONE` — `src/lib/i18n/format.ts` hardcodes `Asia/Jakarta`;
  per-tenant timezone comes from `awcms_mini_tenant_settings` (DB).
- `APP_DEFAULT_LOCALE` — `src/lib/i18n/locale.ts` hardcodes
  `DEFAULT_LOCALE = "en"` as the runtime fallback (the exact `id` vs `en`
  drift called out in this issue's evidence); per-tenant locale comes from
  `awcms_mini_tenants.default_locale` (DB).
- `AWCMS_MINI_NODE_ID` — node identity is resolved from
  `awcms_mini_sync_nodes` (DB), never read from this env var.
- `STORAGE_DRIVER` / `LOCAL_STORAGE_PATH` — never read; the real
  local-vs-R2 switch for the sync object queue is `R2_ENABLED`.

New tests: `tests/unit/config-registry.test.ts` (registry field
completeness, no leaked secret values across every registry-declared
secret var in `runEnvValidation`'s output, a minimal offline/LAN config
derived from the registry's `required` vars passes validation, and
explicit locale/timezone/storage source-of-truth tests) and
`tests/unit/config-docs-check.test.ts` (drift-detection fixtures, plus an
assertion that the real repository files are in sync today).
