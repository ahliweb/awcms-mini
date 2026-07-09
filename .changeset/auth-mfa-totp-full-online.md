---
"awcms-mini": minor
---

Add MFA/TOTP login challenge for full-online deployments (Issue #589,
epic #587-#593) — the second concrete feature built on top of the #587
full-online security gate, following the same pattern as Cloudflare
Turnstile (#588).

New tables (migration 034, tenant-scoped, RLS `ENABLE`+`FORCE`):
`awcms_mini_identity_mfa_factors`, `awcms_mini_identity_mfa_recovery_codes`,
`awcms_mini_mfa_challenges`. `isMfaRequired(env)` combines the shared
`isFullOnlineSecurityActive(env)` gate (#587) with a new `AUTH_MFA_ENABLED`
flag — active only when both agree, and even then MFA is opt-in per
identity, not mandatory tenant-wide.

`POST /api/v1/auth/login`: a password-valid login for an identity with an
active TOTP factor no longer creates a session — it issues an MFA
challenge and returns `401 MFA_REQUIRED` with `mfaChallengeToken`. New
`POST /api/v1/auth/mfa/totp/verify` (authenticated by possession of that
token, not a session — mirrors `password/reset`'s pattern) completes the
login and creates the real session. New self-service endpoints:
`GET /auth/mfa/status`, `POST /auth/mfa/totp/enroll/start`,
`POST /auth/mfa/totp/enroll/verify` (activates the factor, returns 10
one-time recovery codes), `POST /auth/mfa/totp/disable`, and
`POST /auth/mfa/recovery-codes/regenerate` (both high-risk, audited).

TOTP is a from-scratch, dependency-free RFC 6238-compatible implementation
(HMAC-SHA1, verified against the RFC's own Appendix B test vectors) —
Google Authenticator and compatible apps work out of the box. TOTP secrets
are encrypted at rest with AES-256-GCM (`AUTH_MFA_SECRET_ENCRYPTION_KEY`,
base64 32-byte key) — the only reversibly-stored secret in this app, since
verification must recompute the code from the original secret; recovery
codes and challenge tokens remain hash-only like every other token in this
codebase. Replay of an already-used TOTP time step is prevented via a
per-factor `last_used_step` counter, and challenge/recovery-code/replay
state transitions are all atomic (`SELECT ... FOR UPDATE` on the
challenge row plus compare-and-swap `UPDATE`s) so concurrent verification
attempts against the same challenge or code can't bypass the attempt cap
or the replay guard — found and fixed during PR review, with regression
tests proving the race. Password reset never disables MFA (verified by
an explicit integration test).

New env vars: `AUTH_MFA_ENABLED` (default `false`),
`AUTH_MFA_SECRET_ENCRYPTION_KEY`, `AUTH_MFA_TOTP_ISSUER` (default
`AWCMS-Mini`), `AUTH_MFA_TOTP_PERIOD_SEC` (default `30`),
`AUTH_MFA_TOTP_DIGITS` (default `6`), `AUTH_MFA_CHALLENGE_TTL_SEC` (default
`300`), `AUTH_MFA_RATE_LIMIT_MAX`/`_WINDOW_SEC` (defaults `5`/`300`).
`AUTH_MFA_ENABLED=true` alone (independent of the #587 gate) requires a
valid 32-byte base64 encryption key in `bun run config:validate` and
`security-readiness`.

New error codes `MFA_REQUIRED`/`MFA_DISABLED`/`MFA_ALREADY_ACTIVE`/
`MFA_NOT_ACTIVE`/`MFA_ENROLLMENT_NOT_FOUND`/`MFA_INVALID_CODE`/
`MFA_CHALLENGE_INVALID`/`MFA_MISCONFIGURED` with i18n strings (`en`/`id`).
OpenAPI spec updated for `POST /auth/login`'s new 401 branch and all 6 new
endpoints.

Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
`docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
skill `awcms-mini-auth-online-hardening`.
