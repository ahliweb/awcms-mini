---
"awcms-mini": minor
---

Add an optional Cloudflare DNS adapter for the `tenant_domain` module
(Issue #567, epic #555 — the epic's final issue). Manual domain management
(`POST /api/v1/tenant/domains/{id}/verify`, Issue #562) remains the MVP
default; this issue adds a provider boundary, not a hard dependency, and
**no route calls it yet** — wiring it into `.../verify` or a "provision
platform subdomain" flow is left for future work.

Four new env vars, all optional/backward-compatible
(`src/modules/tenant-domain/domain/tenant-domain-dns-config.ts`,
`scripts/validate-env.ts`'s new `checkTenantDomainDnsConfig`):
`TENANT_DOMAIN_DNS_PROVIDER` (`manual` default | `cloudflare`),
`TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN`, `TENANT_DOMAIN_CLOUDFLARE_ZONE_ID`,
and `TENANT_DOMAIN_CLOUDFLARE_API_TOKEN` — the last three required only
when `TENANT_DOMAIN_DNS_PROVIDER=cloudflare`.
`TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` is deliberately a separate variable
from `PUBLIC_PLATFORM_ROOT_DOMAIN` (Issue #556) even though the two will
often share a value — one gates the public host-based resolver (#559),
the other scopes which hostnames this adapter is allowed to touch.

New adapter, `src/modules/tenant-domain/infrastructure/cloudflare-dns-adapter.ts`:
a `TenantDomainDnsProvider` port with `createVerificationRecord` (creates a
TXT/CNAME record, idempotent by construction — lists for an existing
matching record before writing) and `checkVerificationStatus` (lists and
compares against an expected value, normalizing CNAME case/trailing dot).
Both calls are timeout-bounded (`withTimeout`, default 8s) and gated by a
shared circuit breaker, mirroring
`email/infrastructure/mailketing-provider.ts` and
`sync-storage/infrastructure/object-storage-uploader.ts`; both are meant to
run outside any DB transaction (ADR-0006).

Security: the Cloudflare API token/zone id are read only from env — never
persisted to `awcms_mini_tenant_domains` or `awcms_mini_module_settings`,
never rendered in any response. `validateDnsRecordInput` (exported, pure)
rejects any `recordName` outside `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` (or a
subdomain of it) before any network call. Provider errors are redacted:
only Cloudflare's numeric `errors[].code` values are surfaced (never
`.message`), and a `redact()` pass strips the configured token/zone id out
of any thrown-error text as defense in depth, before truncation.

Test: `tests/unit/cloudflare-dns-adapter.test.ts` (pure validation cases,
plus a local `Bun.serve` fake Cloudflare API covering success, idempotent
re-create, provider error with redaction proof, timeout, circuit-breaker
trip, and `resolveTenantDomainDnsProvider`'s missing/invalid-env behavior)
and `tests/validate-env.test.ts`'s new `checkTenantDomainDnsConfig`
`describe` block. Docs: `src/modules/tenant-domain/README.md` §Cloudflare
DNS adapter, `docs/awcms-mini/18_configuration_env_reference.md` §Cloudflare
DNS adapter, `.env.example`.
