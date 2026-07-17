---
"awcms-mini": patch
---

Audit successful and failed password sign-ins (Issue #821).

`POST /api/v1/auth/login` imported `recordAuditEvent` but only ever called it
for `mfa_challenge_issued`, so neither a successful nor a failed password login
left any trace — no audit trail existed for brute-force or credential-stuffing
against the endpoint, and doc 01's base-ready requirement "Audit log high-risk
tersedia" was unmet in code.

The endpoint now writes exactly one `login_succeeded` or `login_failed` audit
row per attempt, carrying the tenant, identity, method, source fingerprint,
user agent, correlation ID, and — on failure — the deny reason
(`invalid_credentials` / `locked` / `tenant_inactive` /
`password_login_disabled`). `POST /api/v1/auth/mfa/totp/verify` gained the
matching `mfa_challenge_failed` row, the one auth outcome in that route that
was still untraced.

Notes:

- Failed logins stay on the record even when the login transaction is rolled
  back: an exception unwinding it is re-recorded out of band as
  `login_failed` / `internal_error`, and the original error is rethrown
  untouched.
- Audit content cannot be used to enumerate accounts: the attacker-supplied
  `loginIdentifier` is never persisted, and an unknown account produces the
  same `invalid_credentials` reason as a real account with a wrong password.
- Source IPs are persisted as a keyed `ipHash`, never in the clear — rows stay
  groupable by source without the audit trail becoming an address log.
- No request or response shape changed; no migration.
