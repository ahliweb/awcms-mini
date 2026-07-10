---
"awcms-mini": patch
---

Cap the number of active tenant OIDC SSO providers a tenant may configure
(Issue #612, follow-up from the second security-auditor review of Issue
#610/PR #611).

Once #610 correctly scoped every `generic-oidc-client.ts` cache/circuit-
breaker by `${tenantId}:${providerKey}`, each new `awcms_mini_auth_providers`
row a tenant creates gets its own fully independent probing budget. Without
a cap, a malicious/compromised tenant admin (the same threat actor already
accepted for #603/#610 — this requires the existing
`identity_access.sso_providers.create` ABAC permission) could register an
unbounded number of provider rows, each pointing at a different internal
target, to multiply their total internal-network probing volume linearly.

`POST /api/v1/identity/sso/providers` now rejects with
`409 SSO_PROVIDER_LIMIT_EXCEEDED` once a tenant's count of active
(non-soft-deleted) provider rows reaches `AUTH_SSO_MAX_PROVIDERS_PER_TENANT`
(default 20, `resolveSsoMaxProvidersPerTenant` in `src/lib/auth/sso-config.ts`).
The count-then-insert check in `createAuthProvider` is deliberately not made
atomic (no `SELECT ... FOR UPDATE`) — this bounds a probing budget, it is
not a security invariant like MFA replay prevention, so a small overshoot
from concurrent creates is harmless for what it defends against.
