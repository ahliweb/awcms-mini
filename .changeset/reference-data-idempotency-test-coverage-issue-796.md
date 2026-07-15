---
"awcms-mini": patch
---

Add adversarial cross-resource Idempotency-Key-reuse regression tests
(Issue #796) for `reference-data` `tenant-codes/{id}` and
`value-sets/{key}/codes/{code}` `PATCH`/`DELETE`, the two endpoint pairs
`tests/integration/reference-data.integration.test.ts` never exercised
after PR #783's (Issue #750) round-2 idempotency-hash fix. Each new test
proves reusing an Idempotency-Key across two different resources of that
type with an identical-shaped body yields `409 IDEMPOTENCY_CONFLICT`
(re-fetching the second resource to confirm it was not silently mutated),
and that the second resource's own distinct key then genuinely applies its
mutation. No production behavior change — closes the last known
test-coverage gap from the idempotency-hash-not-bound-to-resource-id defect
class across all 11 originally-affected endpoints.
