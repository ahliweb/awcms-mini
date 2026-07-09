---
"awcms-mini": patch
---

Close the documentation/contract/readiness loop for the full-online auth
security hardening epic (Issue #593, epic #587-#593) — the audit/closure
issue, not a new auth feature.

Fixed real gaps found by the audit:

- `docs/awcms-mini/18_configuration_env_reference.md` and
  `deployment-profiles.md` still said "#592-#593 backlog" even though the
  admin policy UI (#592) had already merged — corrected to reflect the
  epic's actual state.
- `docs/awcms-mini/20_threat_model_security_architecture.md` had zero
  mentions of Turnstile/MFA/Google OIDC/SSO/break-glass — added a new
  section mapping this epic's seven requested threat categories (credential
  stuffing, bot abuse, OIDC callback abuse, provider outage, MFA recovery
  abuse, SSO lockout, offline dependency breakage) to concrete evidence.
- `scripts/security-readiness.ts` adds `checkSsoBreakGlassReady` (critical):
  `saveTenantAuthPolicy` (#591) only validates that a tenant's
  `sso_required=true`/`password_login_enabled=false` policy has an eligible
  break-glass identity at the moment the policy is SAVED. A break-glass
  identity can be deactivated (or lose its tenant membership) by an
  unrelated action afterward without the policy ever being re-saved,
  silently leaving the tenant with no way back into local password login.
  The new check re-derives eligibility from a fresh database read, for
  every active tenant, at `bun run security:readiness` time — reusing
  `countEligibleBreakGlassIdentities` (now exported from
  `tenant-auth-policy.ts`) so the eligibility rule is never re-derived a
  second, divergent way. Covered by a new integration test,
  `tests/integration/security-readiness-break-glass.integration.test.ts`.
  Per-tenant errors during the scan are isolated (caught individually
  inside the loop) rather than aborting the whole check on the first bad
  tenant — a single tenant with an unexpected query failure no longer
  masks a genuine at-risk finding for every other tenant.

Everything else audited (`.env.example`, `scripts/validate-env.ts`,
OpenAPI, `src/modules/identity-access/README.md`) was already accurate
from #587-#591 and is confirmed, not changed.
