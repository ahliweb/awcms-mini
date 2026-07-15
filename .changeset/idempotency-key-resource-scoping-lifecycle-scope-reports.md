---
"awcms-mini": patch
---

Fix the recurring "Idempotency-Key hash not bound to resource identity"
defect class (Issue #795, found via the independent security-auditor
pass on PR #783 / Issue #750) in `data_lifecycle`, `identity_access`
business-scope, and `reporting`.

Since the idempotency store key is `(tenant_id, request_scope,
idempotency_key)` and `request_scope` is a per-endpoint-TYPE constant
shared across every resource of that type in a tenant, an endpoint that
computed its request hash from the body alone (or from `{}` for a pure
action-trigger) while the URL's path parameter identified WHICH resource
was being mutated let a client that reused the same `Idempotency-Key`
across two DIFFERENT resources of the same type silently replay the
first resource's cached response for a request meant to mutate the
second — a false "success" that masked a mutation that never executed.

Fixed by folding the identifying path parameter(s) plus an explicit
`action` literal into `computeRequestHash`, alongside the real body
content where one exists:

- `POST /api/v1/data-lifecycle/legal-holds/{id}/release`
- `POST /api/v1/identity/business-scope/assignments/{id}/revoke`
- `POST /api/v1/identity/business-scope/exceptions/{id}/approve`
- `POST /api/v1/identity/business-scope/exceptions/{id}/reject`
- `POST /api/v1/identity/business-scope/exceptions/{id}/revoke`
- `POST /api/v1/reports/projections/{key}/rebuild/cancel` (was
  `computeRequestHash({})` — completely empty, the same shape as the
  original bug)

`POST /api/v1/data-lifecycle/legal-holds` (the collection-level create
endpoint) was audited and confirmed NOT vulnerable to this class: it has
no `{id}`/`{key}` path parameter identifying a pre-existing resource, so
there is no second resource whose response could be falsely replayed.

Adds adversarial integration tests
(`tests/integration/business-scope-assignments.integration.test.ts`,
`tests/integration/reporting-projections.integration.test.ts`) proving
that reusing the same `Idempotency-Key` across two DIFFERENT resources
of the same type now yields a clean `409 IDEMPOTENCY_CONFLICT`, that the
second resource's real DB state is left untouched by the false-replay
attempt, and that it still executes correctly once given its own
distinct key — mirroring PR #783's test rigor.

This is a partial fix for Issue #795, split across three parallel PRs by
module cluster; `document-infrastructure`/`organization-structure` and
`reference-data`'s own already-merged fix (PR #783) round out the rest
of the repo-wide grep.
