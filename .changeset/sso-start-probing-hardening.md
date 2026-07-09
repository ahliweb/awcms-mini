---
"awcms-mini": patch
---

Harden the unauthenticated `GET /api/v1/auth/sso/{providerKey}/start`
endpoint against internal-network probing (Issue #610, follow-up from the
Issue #603 SSRF risk-acceptance decision for tenant-configured OIDC
`issuer_url`). Narrows, but does not eliminate, an accepted residual risk
— does not reopen the "no IP-range blocking" decision itself.

- `src/pages/api/v1/auth/sso/[providerKey]/start.ts` now enforces a second,
  AGGREGATE (not per-source) rate limit keyed by `${tenantId}:${providerKey}`,
  on top of the existing per-source+tenant limiter. The per-source limiter
  bounds how fast any one client can hit this endpoint but does nothing
  against many different source IPs each staying under that limit while
  collectively probing the same tenant-configured `issuer_url` — the new
  check bounds total request volume against one specific provider
  regardless of source rotation. New env vars:
  `AUTH_SSO_PROVIDER_RATE_LIMIT_MAX` (default `60`) and
  `AUTH_SSO_PROVIDER_RATE_LIMIT_WINDOW_SEC` (default `60`).
- `src/lib/auth/generic-oidc-client.ts`'s `discoverOidcConfiguration` and
  `fetchProviderJwks` now cache FAILED attempts for 30 seconds
  (`discoveryFailureCache`/`jwksFailureCache`), in addition to the existing
  60-minute cache for successful ones. Previously, a target that never
  returns a valid OIDC document got a fresh live network attempt on every
  single unauthenticated `/start` hit; now repeated hits within the
  negative-TTL window return the same cached failure instantly, removing
  most of the timing/liveness signal an internal-network prober could
  otherwise read from repeated probes.
- Documented an infra-layer recommendation in
  `docs/awcms-mini/deployment-profiles.md` (§Generic tenant OIDC SSO): for
  `full_online` deployments (the only profile where this feature is
  reachable, and the profile most likely to run on cloud infrastructure),
  operators should block/restrict the app container's egress to the cloud
  metadata endpoint (`169.254.169.254`) at the network/firewall level, or
  enforce IMDSv2 with hop-limit=1. This is application-external and out of
  this codebase's scope, but is the most concrete residual for `full_online`
  specifically.

New tests: `tests/unit/generic-oidc-client.test.ts` (negative-cache
behavior, scoped correctly per `providerKey`) and a new integration test in
`tests/integration/tenant-sso-flow.integration.test.ts` ("start rate-limits
aggregate requests to one providerKey across many DIFFERENT source IPs")
proving the aggregate limiter trips at the 61st request across 60 distinct
`X-Forwarded-For` values, none of which individually cross the existing
per-source limit.

Updated `docs/awcms-mini/20_threat_model_security_architecture.md` and the
`awcms-mini-auth-online-hardening` skill to reflect that this residual is
now meaningfully throttled rather than "no real throttling."
