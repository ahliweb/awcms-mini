---
"awcms-mini": minor
---

Close the account-enumeration oracles on `POST /api/v1/auth/login` (Issue #840).

An unauthenticated caller could confirm that a given `loginIdentifier` exists
without ever guessing its password, strengthening credential stuffing and
targeted phishing (OWASP ASVS V2.2.1 / WSTG-IDNT-04). Two oracles existed, and
the larger one was not the reported one.

**Response body.** `locked` and `password_login_disabled` are reachable only
once the identity has resolved (`login-policy.ts` guards both with
`input.identity`), so their distinct responses disclosed existence. Both now
answer with the same `401 AUTH_INVALID_CREDENTIALS` and the same
`"Invalid login identifier or password."` message as an unknown identifier.
For `locked` this is a message-only change — it already returned
`401 AUTH_INVALID_CREDENTIALS`, and only the human-readable
`"Account is temporarily locked."` gave it away — and it was the practical
oracle: reachable in ~6 requests on a **default** deployment by tripping
`AUTH_LOGIN_MAX_ATTEMPTS` and reading the message back.

**Timing (the bigger one, and not in the issue).** `login.ts` skipped
`verifyPassword` entirely for an unknown identifier
(`identityRow ? await verifyPassword(...) : false`). Measured on the repo's own
integration harness, an unknown identifier answered in a median of **4.13 ms**
against **80.13 ms** for a known one — a ~19x gap that enumerates accounts in a
**single request**, with no lockout to trip, on default configuration. Fixing
only the bodies would have left it wide open. `verifyPasswordOrDummy`
(`src/lib/auth/password.ts`) now always spends an equivalent argon2id verify,
against a lazily-memoized dummy hash produced by `hashPassword` itself so its
parameters always match real hashes. Measured after: **90.46 ms** vs
**90.29 ms** (ratio 1.002). This equalizes the dominant cost, not every
instruction, and is not claimed as a constant-time proof.

**Behavior changes callers may notice.**

- `403 PASSWORD_LOGIN_DISABLED` is no longer returned by this endpoint. A
  tenant with `password_login_enabled=false` (Issue #591) now denies
  non-break-glass identities with `401 AUTH_INVALID_CREDENTIALS`. Enforcement
  is unchanged (no session is issued) and break-glass identities still sign in
  normally. Beyond leaking existence, the old `403` fingerprinted exactly which
  identities are **break-glass** — the accounts that retain password access,
  i.e. the highest-value targets in that configuration.
- A locked account no longer says so in the response.

The real deny reason is unchanged server-side and still recorded on every
attempt as `login_failed`'s `reason` attribute (`locked`,
`password_login_disabled`, `invalid_credentials`), so operators lose nothing.
`403 ACCESS_DENIED` for an inactive tenant stays distinct: it is decided from
the tenant header before any identity is looked at and is returned identically
for every identifier, so it cannot enumerate.

**Accepted cost.** A genuinely locked user, and a user at an SSO-required
tenant, now get a generic message with no hint about why. Those hints belong on
channels that cannot be probed anonymously — a verified-email notification, and
tenant-wide SSO discovery on the login page. Neither exists yet; the login page
has no provider-discovery endpoint to surface "sign in with SSO" today, which
is the natural follow-up.
