---
"awcms-mini": minor
---

Add Google OIDC login for full-online deployments (Issue #590, epic
#587-#593) — the third concrete feature built on top of the #587
full-online security gate, following the same pattern as Cloudflare
Turnstile (#588) and MFA/TOTP (#589).

New tables (migration 035, tenant-scoped, RLS `ENABLE`+`FORCE`):
`awcms_mini_identity_provider_accounts` (links an identity to a Google
account by its stable `sub`, never by email), `awcms_mini_oidc_auth_requests`
(the ephemeral state/nonce bridge across the OAuth redirect round-trip).
`isGoogleLoginRequired(env)` combines the shared `isFullOnlineSecurityActive(env)`
gate (#587) with a new `AUTH_GOOGLE_LOGIN_ENABLED` flag.

New endpoints: `GET /api/v1/auth/providers/google/start` (unauthenticated,
redirects to Google; reached from a new conditional "Continue with Google"
button on `/login`), `GET .../callback` (Google's redirect target —
validates `state`/nonce (CSRF/replay defense) and cryptographically
verifies the ID token's RS256 signature, issuer, audience, expiry, and
nonce before trusting any claim; creates the existing AWCMS-Mini session
type, or — if Issue #589's MFA gate is active for the identity — returns
`401 MFA_REQUIRED` exactly like `POST /auth/login`, so Google login never
bypasses MFA), `POST .../link` (authenticated; starts a link-purpose OAuth
request for the caller's own identity and returns the authorization URL as
JSON), `POST .../unlink` (authenticated, high-risk, audited).

The RS256 signature verification is implemented via the platform's own
WebCrypto (`crypto.subtle`) rather than a JWT library dependency. Google's
token exchange and JWKS fetch are timeout-bounded and circuit-breaker
gated, with the breaker only tripping on genuine transport failures
(5xx/network/timeout) — a well-formed `400 invalid_grant` for a bad/reused
authorization code is Google correctly rejecting attacker-controlled
input, not an outage, and must never trip the breaker (the same class of
bug found and fixed in Turnstile's PR #596).

Account linking is by Google's `sub` only. Auto-linking a Google login to
an existing identity by email is fail-closed: it requires both a verified
email and the email's domain to be explicitly listed in the new
`AUTH_GOOGLE_ALLOWED_DOMAINS` env var (default unset — auto-linking never
happens by default). Without an existing link or an eligible auto-link,
login is rejected (`GOOGLE_ACCOUNT_NOT_LINKED`), never silently
provisioning a new account.

New env vars: `AUTH_GOOGLE_LOGIN_ENABLED` (default `false`),
`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`,
`AUTH_GOOGLE_ALLOWED_DOMAINS` (default unset), `AUTH_GOOGLE_REDIRECT_PATH`
(default `/api/v1/auth/providers/google/callback`). `AUTH_GOOGLE_LOGIN_ENABLED=true`
alone (independent of the #587 gate) requires a client id and secret in
`bun run config:validate` and `security-readiness`.

New error codes `GOOGLE_LOGIN_DISABLED`/`GOOGLE_OAUTH_STATE_INVALID`/
`GOOGLE_TOKEN_EXCHANGE_FAILED`/`GOOGLE_ID_TOKEN_INVALID`/
`GOOGLE_ACCOUNT_NOT_LINKED`/`GOOGLE_ALREADY_LINKED`/`GOOGLE_NOT_LINKED`/
`GOOGLE_MISCONFIGURED` with i18n strings (`en`/`id`). OpenAPI spec updated
for all 4 new endpoints.

Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
`docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
skill `awcms-mini-auth-online-hardening`.
