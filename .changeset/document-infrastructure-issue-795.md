---
"awcms-mini": patch
---

Security fix (Issue #795, recurring class first found in PR #783/#750 `reference_data`): seven `document_infrastructure` mutation endpoints computed their `Idempotency-Key` request hash without folding in the path parameter identifying WHICH resource was being mutated. Since the idempotency store key is `(tenant_id, request_scope, idempotency_key)` and `request_scope` is shared across every resource of a type in the tenant, a client that reused the same `Idempotency-Key` across two different resources of the same type could have the second request incorrectly replay the first resource's cached response instead of being rejected or executed — silently reporting success for a resource that was never touched.

Fixed:

- `documents/{id}/restore` and `classifications/{id}/restore` hashed `{}` (empty, no `id` at all) — now hash `{ id, action: "restore" }`.
- `documents/{id}` DELETE hashed `body` alone — now hashes `{ ...body, id, action: "delete" }`.
- `classifications/{id}` DELETE hashed `body` alone — now hashes `{ ...body, id, action: "deactivate" }` (the underlying operation is a deactivation, not a hard delete).
- `documents/{id}/relations/{relationId}` DELETE hashed `body` alone — now hashes `{ ...body, relationId, action: "unlink" }`.
- `reservations/{id}/cancel` hashed `body` alone — now hashes `{ ...body, id, action: "cancel" }`.
- `reservations/{id}/commit` hashed `body` alone — now hashes `{ ...body, id, action: "commit" }`.

`sequences/revise`, `sequences/restore`, and `sequences/deactivate` were audited and found NOT vulnerable: these are index-level routes (no `[id]`/`[key]` path segment) whose resource identity (`scopeType` + `scopeId` + `sequenceKey`) is already part of the raw request body being hashed, so a reused key across two different sequences already correctly produces a different hash.

Adds adversarial integration tests (`tests/integration/document-infrastructure.integration.test.ts`) proving that reusing an Idempotency-Key across two different documents/classifications/reservations with an identical-shaped (or empty) body yields `409 IDEMPOTENCY_CONFLICT`, that the second resource is left untouched by the false-replay attempt (asserted against real DB state), and that it still applies correctly once given its own key.

Part of #795 (parallel module-scoped fix; `reference-data` fixed in #783/#750, `organization-structure`/`data-lifecycle`/`identity` business-scope handled in a sibling PR).
