---
"awcms-mini": patch
---

Make the optional Cloudflare DNS adapter's (Issue #567, `tenant_domain`
module) per-call network timeout configurable, closing a Low-severity
follow-up from the `awcms-mini-security-auditor` review on PR #580: the
timeout was previously hardcoded (`DEFAULT_TIMEOUT_MS = 8_000` in
`cloudflare-dns-adapter.ts`) with no way to tune it per-deployment.

Added `resolveTenantDomainCloudflareTimeoutMs(env)` to
`tenant-domain/domain/tenant-domain-dns-config.ts`, following the exact
same pattern `email/domain/email-config.ts`'s
`resolveEmailSendTimeoutMs` already uses for `EMAIL_SEND_TIMEOUT_MS`:
reads the new `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS` env var, falls back
to the existing 8-second default for any unset or non-positive value,
and is never validated by `scripts/validate-env.ts` (an invalid value
can never fail boot — same reasoning as the email timeout). This
adapter is still not wired into any route (Issue #567's own scope, and
this PR does not change that) — the timeout only matters once a future
issue wires the adapter into a real endpoint, but the config exists now
so that issue doesn't have to add it under time pressure.

`resolveTenantDomainDnsProvider(env)` — the production resolver — now
passes this resolved value through to `createCloudflareDnsProvider`.

New tests in `tests/unit/cloudflare-dns-adapter.test.ts`: unit coverage
for `resolveTenantDomainCloudflareTimeoutMs` (default, valid override,
non-numeric fallback, zero/negative fallback), plus a test confirming a
resolved env-sourced timeout value is enforced the same way an existing
test already proved for a raw `timeoutMs` number.

Docs updated: `.env.example`, doc 18 (env reference table + Cloudflare
adapter security note), `tenant-domain/README.md`, and skill
`awcms-mini-tenant-domain-routing` (moved from open follow-up to "sudah
diperbaiki").
