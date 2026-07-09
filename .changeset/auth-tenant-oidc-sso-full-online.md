---
"awcms-mini": minor
---

Add generic tenant OIDC SSO provider for full-online deployments (Issue
#591, epic #587-#593) — generalizes Issue #590's Google-specific login
into a tenant-configurable OIDC provider model (Okta, Azure AD, Keycloak,
etc.), without changing Google's own code/tables. `isSsoRequired(env)`
combines the shared `isFullOnlineSecurityActive(env)` gate (#587) with a
new `AUTH_SSO_ENABLED` flag, following the same pattern as Turnstile
(#588), MFA/TOTP (#589), and Google login (#590).

New tables (migration 036, tenant-scoped, RLS `ENABLE`+`FORCE`):
`awcms_mini_auth_providers` (per-tenant OIDC provider config — issuer,
client id, client secret encrypted at rest with a dedicated
`AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` or referenced by environment
variable name, exactly one via a CHECK constraint, never returned
plaintext by any endpoint; scopes; allowed email domains; enabled flag;
soft delete) and `awcms_mini_tenant_auth_policies` (one row per tenant —
`password_login_enabled`, `sso_enabled`, `sso_required`,
`auto_link_verified_email`, allowed email domains, break-glass identity
ids, and `mfa_required` reserved for future #589 compatibility). The
existing `awcms_mini_identity_provider_accounts`/
`awcms_mini_oidc_auth_requests` tables (migration 035) are reused as-is
for the generic flow — they were already designed provider-agnostic
specifically for this.

New endpoints: `GET /api/v1/auth/sso/{providerKey}/start|callback`,
`POST /api/v1/auth/sso/{providerKey}/link|unlink` (same shape as Google's
own endpoints — unauthenticated tenant existence is `SELECT`ed before any
INSERT, applying PR #598's lesson from day one). Also new — admin CRUD,
in scope for this issue unlike #590: `/api/v1/identity/sso/providers`
(`/{id}`) and `/api/v1/identity/sso/policy`, protected by ABAC
(`identity_access.sso_providers.*`/`sso_policy.*`, migration 037), never
gated by the runtime SSO flag itself (credentials can be provisioned
ahead of time, same allowance Turnstile/Google's own config checks
grant).

Unlike Google (hardcoded OAuth endpoints), a tenant-configured provider's
`.well-known/openid-configuration` and JWKS are discovered per provider,
cached, and bounded by `AUTH_SSO_DISCOVERY_TIMEOUT_MS` — circuit breakers
are keyed per provider (`sso-oidc-discovery:<key>`/`sso-oidc-jwks:<key>`/
`sso-oidc-token:<key>`) so one tenant's unhealthy provider never affects
another tenant or provider, and only trip on genuine transport failures
(5xx/network/timeout), never a well-formed 4xx from the provider
correctly rejecting a bad/reused authorization code.

Break-glass enforcement is the headline security behavior: a tenant
policy that would set `sso_required=true` or `password_login_enabled=false`
is rejected (`409 BREAK_GLASS_REQUIRED`) unless at least one configured
break-glass identity currently resolves to an `active` identity with an
`active` tenant membership — checked at the point the policy is SAVED
(against a fresh DB read), not merely at login time, so a provider outage
can never lock an operator out of their own tenant. `login.ts` enforces
`password_login_enabled=false` only when `isSsoRequired(env)` is active;
every deployment that never enables this feature runs zero extra queries
and has zero behavior change.

Auto-linking by email is fail-closed on two independent layers: the
provider's own allowed-domain list (mirrors Google's
`AUTH_GOOGLE_ALLOWED_DOMAINS`, per tenant/provider) AND the tenant
policy's `auto_link_verified_email` master switch, which defaults to
`false`.

New env vars: `AUTH_SSO_ENABLED` (default `false`),
`AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` (base64, 32-byte AES-256 key,
required and validated when enabled — a separate key from MFA's own),
`AUTH_SSO_DISCOVERY_TIMEOUT_MS` (default `5000`).

New error codes `SSO_DISABLED`/`SSO_PROVIDER_NOT_FOUND`/
`SSO_PROVIDER_DISABLED`/`SSO_PROVIDER_UNAVAILABLE`/
`SSO_OAUTH_STATE_INVALID`/`SSO_TOKEN_EXCHANGE_FAILED`/
`SSO_ID_TOKEN_INVALID`/`SSO_ACCOUNT_NOT_LINKED`/`SSO_ALREADY_LINKED`/
`SSO_NOT_LINKED`/`SSO_MISCONFIGURED`/`SSO_PROVIDER_KEY_CONFLICT`/
`BREAK_GLASS_REQUIRED`/`PASSWORD_LOGIN_DISABLED` with i18n strings
(`en`/`id`). OpenAPI spec updated for all 11 new endpoints and their
schemas.

Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
`docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
skill `awcms-mini-auth-online-hardening`.
