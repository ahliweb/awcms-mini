---
"awcms-mini": minor
---

Add the public host tenant resolver (Issue #559, epic #555):
`src/lib/tenant/public-host-tenant-resolver.ts` resolves the public tenant
for anonymous requests from `Host`/domain/subdomain, then falls back
safely to `PUBLIC_DEFAULT_TENANT_ID` -> `PUBLIC_DEFAULT_TENANT_CODE` ->
`awcms_mini_setup_state.tenant_id` -> generic `null` (404). Host-based
lookup only runs when `PUBLIC_TENANT_RESOLUTION_MODE=host_default`; the
env/setup fallback chain always runs regardless of mode, so existing
offline/LAN deployments that never set `PUBLIC_*` never touch the new
lookup path at all. `X-Forwarded-Host` is read only when
`PUBLIC_TRUST_PROXY=true` is explicitly passed by the caller. Every
failure case (unknown host, non-`active` domain status, soft-deleted
domain, inactive tenant) returns an identical `null` — no distinguishable
signal.

Adds `sql/033_awcms_mini_tenant_domain_lookup_function.sql`, a narrowly
scoped `SECURITY DEFINER` function
(`awcms_mini_resolve_tenant_domain_lookup`) that closes the RLS bootstrap
gap flagged in migration 031: it is the single sanctioned read path for
`hostname -> tenant` before any tenant context exists. It joins the
already-RLS-free `awcms_mini_tenants` row into the same call (no new
privilege exposure — those columns are unconditionally public already)
so `resolvePublicTenantByHost` completes in exactly one DB round trip for
every outcome, closing a timing side-channel an earlier version had
between "unmapped host" and "mapped but inactive tenant". `EXECUTE` is
`REVOKE`d from `PUBLIC` and granted only to `awcms_mini_app`. `FORCE ROW
LEVEL SECURITY` remains on `awcms_mini_tenant_domains` — direct queries
against the table from the app role still return zero rows without a
tenant GUC, proven alongside the function's bypass behavior and its
single-round-trip property in
`tests/integration/public-tenant-resolution.integration.test.ts`.

`X-Forwarded-Host` handling also hardens against a misconfigured/spoofed
multi-value header: if it ever contains more than one comma-separated
value (never expected for this repo's documented single-trusted-proxy
topology), the resolver does not guess which entry is trustworthy — it
logs the anomaly and falls back to the plain `Host` header, exactly as if
`PUBLIC_TRUST_PROXY` were `false` for that request. The requirement that a
trusted proxy must fully overwrite (never append to) `X-Forwarded-Host` is
now documented as binding in
`docs/awcms-mini/18_configuration_env_reference.md`,
`docs/awcms-mini/deployment-profiles.md`, and the
`awcms-mini-tenant-domain-routing` skill.

A general "Using `SECURITY DEFINER`" checklist (owner-is-superuser
verification, static/parameterized body, minimal returned columns,
explicit `EXECUTE` grant, `search_path` pinning, empirical verification,
timing-side-channel awareness) is added to
`docs/adr/0003-postgresql-rls-multi-tenant.md` and the
`awcms-mini-new-migration` skill, referencing migration 033 as the
canonical example, so future `SECURITY DEFINER` functions in this repo
don't have to rediscover these rules from scratch.

Library only — not yet consumed by any route/endpoint (that is Issue
#560's `/news` routes). Covered by
`tests/unit/public-host-tenant-resolver.test.ts` and
`tests/integration/public-tenant-resolution.integration.test.ts`.
