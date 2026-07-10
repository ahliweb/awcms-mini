---
"awcms-mini": patch
---

Harden the unauthenticated `GET /api/v1/auth/sso/{providerKey}/start` endpoint
against internal-network probing (Issue #610, follow-up from the Issue #603
SSRF risk-acceptance decision for tenant-configured OIDC `issuer_url`).
Narrows — does not eliminate, and does not reopen — the residual risk that
ABAC on provider CRUD only gates who can *configure* a malicious
`issuer_url`, not who can *trigger* the resulting fetch, since `/start` is
unauthenticated by design.

This changeset went through two rounds of security review before landing
in its final shape — both catches are documented here since they're
directly relevant to anyone extending this code later:

**Critical fix, actually pre-existing since Issue #591**: every
cache/circuit-breaker in `src/lib/auth/generic-oidc-client.ts`
(`discoveryCache`, `jwksCache`, and the three provider circuit breakers)
was keyed by `providerKey` ALONE. `provider_key` is only unique PER TENANT
(`awcms_mini_auth_providers`'s unique index is `(tenant_id, provider_key)`),
so two different tenants naming a provider "okta" (extremely common) shared
the same cache entry and circuit-breaker state. A malicious tenant admin
(already needs the same `identity_access.sso_providers.create` privilege
level this epic already treats as a threat actor) could register a
provider under a common vendor slug pointing at an attacker-controlled
server, and have that attacker-controlled `authorization_endpoint`/
`jwks_uri` served to a completely unrelated tenant's identically-named,
legitimately-configured provider — redirecting the victim tenant's real
SSO users to a phishing page and/or letting the attacker forge ID tokens
their own JWKS would "correctly" verify. `discoverOidcConfiguration`,
`fetchProviderJwks`, and `exchangeAuthorizationCode` all now take a
`tenantId` parameter and key every cache/breaker by
`${tenantId}:${providerKey}`. New unit test
(`tests/unit/generic-oidc-client.test.ts`) and integration test
(`tests/integration/tenant-sso-flow.integration.test.ts`) both prove two
tenants using the same `providerKey` string get fully independent results.

**Design correction — an earlier draft of this same changeset introduced a
new bug**: that draft added an aggregate (not per-source) rate limit on
`/start`, keyed by `${tenantId}:${providerKey}`, intended to bound a
prober rotating source IPs against one target. A second security-auditor
pass found this SHARED budget was itself a privilege-free denial-of-service
vector: anyone, from as few as 3 source IPs, could exhaust the entire
budget and lock out every legitimate user of that tenant's SSO login for
the rate-limit window, repeatedly — the review's own test for that
mechanism inadvertently proved it. That aggregate rate limit has been
removed entirely. The actual defense against sustained probing is the
now-correctly tenant+provider-scoped circuit breaker (opens after
consecutive failures, fails fast for 30s) plus the negative-TTL failure
cache below — both only ever throttle FAILING attempts, so neither can
ever block a legitimate login to a healthy provider, unlike a shared HTTP-level
rate limit that blocks every request regardless of outcome.

- `src/lib/auth/generic-oidc-client.ts`'s `discoverOidcConfiguration` and
  `fetchProviderJwks` cache FAILED attempts for 30 seconds
  (`discoveryFailureCache`/`jwksFailureCache`, keyed by
  `${tenantId}:${providerKey}`). Previously, a target that never returns a
  valid OIDC document got a fresh live network attempt on every single
  unauthenticated `/start` hit; now repeated hits within the negative-TTL
  window return the same cached failure instantly.
- Documented an infra-layer recommendation in
  `docs/awcms-mini/deployment-profiles.md` (§Generic tenant OIDC SSO): for
  `full_online` deployments (the only profile where this feature is
  reachable, and the profile most likely to run on cloud infrastructure),
  operators should block/restrict the app container's egress to the cloud
  metadata endpoint (`169.254.169.254`) at the network/firewall level, or
  enforce IMDSv2 with hop-limit=1.

Follow-up filed as Issue #612 (non-blocking): no cap exists on how many
`awcms_mini_auth_providers` rows a single tenant can create, so a malicious
tenant admin could still register many provider rows (each getting its own
independent, now correctly-scoped, cache/breaker budget) to multiply total
probing volume linearly with row count. Deferred per this repo's established
convention of closing what's asked and filing narrow follow-ups rather than
scope-creeping a single PR — the two Critical findings above (cross-tenant
leakage, self-inflicted DoS) were fixed in this same changeset since they
were regressions/gaps in the mechanism this PR itself claims to fix, not
pre-existing out-of-scope concerns.
