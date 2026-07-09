---
"awcms-mini": patch
---

Extend `withTenant`'s database circuit-breaker exclusion (`src/lib/database/tenant-context.ts`,
Issue #599/PR #600) to also cover Postgres SQLSTATE class `22` (data
exception — `22P02` invalid_text_representation, `22003`
numeric_value_out_of_range, and siblings), not just class `23` (integrity
constraint violation).

Follow-up from the security-auditor review of PR #600 (Issue #601): class
`22` errors are structurally the same kind of "bad caller input, not a
database/infra failure" outcome as class `23` — e.g. a non-UUID-shaped
string compared/cast against a `uuid` column throws `22P02`, exactly the
same shape of bug as the FK-violation DoS class `23` was added to guard
against. No live endpoint exploits this today (every caller-supplied
identifier is already format-validated via `assertUuid()` before reaching
SQL), so this closes a structural gap rather than fixing an active
exploit.

`isPostgresIntegrityConstraintViolation` is renamed to
`isPostgresClientInputError` and now checks against both SQLSTATE classes
(`22` and `23`) via a small array, rather than a single hardcoded prefix.
Every other error class (`08` connection exception, `53` insufficient
resources, `57` operator intervention, plain non-Postgres errors, ...)
still trips the breaker exactly as before — verified by two new unit
tests in `tests/unit/tenant-context-circuit-breaker.test.ts` proving
`22P02` and `22003` never trip the breaker across repeated failures,
alongside the existing tests proving genuine infra failures still do.
