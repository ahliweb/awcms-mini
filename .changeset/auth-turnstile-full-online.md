---
"awcms-mini": minor
---

Add Cloudflare Turnstile bot protection for full-online public auth forms
(Issue #588, epic #587-#593) — the first concrete feature built on top of
the #587 full-online security gate.

New `src/lib/security/turnstile.ts`: `isTurnstileRequired(env)` combines
the shared `isFullOnlineSecurityActive(env)` gate (#587) with a new
`TURNSTILE_ENABLED` flag — active only when both agree. Every local/
offline/LAN deployment (the default) is completely unaffected. The one
enforcement entrypoint, `enforceTurnstileIfRequired(turnstileToken,
remoteIp, env)`, is now called from `POST /api/v1/auth/login`,
`/auth/password/forgot`, `/auth/password/reset`, and
`/setup/initialize`, right after body validation but before any DB
query or password hashing. Verification is server-side against
Cloudflare's siteverify endpoint, timeout-bounded and circuit-breaker
gated (same pattern as `cloudflare-dns-adapter.ts`/
`mailketing-provider.ts`), and fails closed: misconfiguration is treated
as an invalid token, not skipped.

New env vars: `TURNSTILE_ENABLED` (default `false`), `TURNSTILE_SITE_KEY`,
`TURNSTILE_SECRET_KEY`, `TURNSTILE_VERIFY_TIMEOUT_MS` (default `5000`).
`TURNSTILE_ENABLED=true` alone (independent of the #587 gate) requires
both keys in `bun run config:validate` and `security-readiness`.

The login page (`src/pages/login.astro`) conditionally renders the
Turnstile widget only when `isTurnstileRequired()` is true. Astro's CSP
(`astro.config.mjs`) now unconditionally allows
`https://challenges.cloudflare.com` in `script-src`/`frame-src` (CSP is
build-time only, while `TURNSTILE_ENABLED` is meant to be runtime-
toggleable) — the widget itself remains runtime-gated.

New error codes `TURNSTILE_REQUIRED`/`TURNSTILE_INVALID` with i18n
strings (`en`/`id`). OpenAPI spec updated for all 4 affected endpoints.

Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
`docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
skill `awcms-mini-auth-online-hardening`.
