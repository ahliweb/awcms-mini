---
"awcms-mini": patch
---

Fix `withTenant`'s shared database circuit breaker (`src/lib/database/tenant-context.ts`)
conflating ordinary Postgres integrity constraint violations with genuine
database/infra failures (Issue #599).

Security review of PR #598 (Issue #590, Google OIDC login) found that an
unauthenticated caller could send a handful of nonexistent `tenantId`
values to `GET /api/v1/auth/providers/google/start`, each tripping a
foreign-key violation inside a `withTenant` transaction. Before this fix,
`withTenant`'s catch-all treated **any** exception (other than the
already-excluded `IdempotencyRaceLostError`) as an infra failure and
recorded it against `getDatabaseCircuitBreaker()` — a single
application-wide breaker shared by every tenant and every
`withTenant`-based endpoint. Five garbage tenant ids were enough to open
the breaker and fail every request for 30 seconds, repeatedly — a larger
blast radius than the analogous per-provider Turnstile circuit-breaker
bug (#596) this same epic already fixed once.

That specific call site was already patched in PR #598 (commit `56b18ee`)
with a `SELECT`-before-`INSERT` existence check, but the same class of
bug exists at any call site with a foreign key or uniqueness constraint
(e.g. `autoLinkByEmail`'s insert into
`awcms_mini_identity_provider_accounts` under a legitimate concurrent
request race in `src/modules/identity-access/application/google-oidc.ts`).

`withTenant` now inspects the thrown error's Postgres SQLSTATE
(`Bun.SQL.PostgresError#errno`) and skips `breaker.recordFailure()` for
class `23` — integrity constraint violation (`23503`
foreign_key_violation, `23505` unique_violation, `23514`
check_violation, and siblings) — mirroring how `IdempotencyRaceLostError`
was already excluded. Every other error (connection failures, timeouts,
syntax errors, permission errors, ...) still trips the breaker exactly as
before. This is centralized in `withTenant` itself, so none of the
~25+ existing endpoints need their own pre-check.

Excluded violations are logged as `database.integrity_violation_excluded`
(SQLSTATE + tenant id, no query data) so operators keep visibility into
how often this happens, matching the existing `idempotency.race_lost`
logging for the other breaker exclusion.

New unit tests in `tests/unit/tenant-context-circuit-breaker.test.ts`
prove: a `23505`/`23503` error thrown inside `withTenant` never trips the
breaker even across repeated failures; a genuine Postgres infra error
(`08006` connection failure) and a plain non-Postgres `Error` still trip
it after the existing 5-consecutive-failure threshold; a successful call
still resets state as before; and the new log line fires with the
correct SQLSTATE.
