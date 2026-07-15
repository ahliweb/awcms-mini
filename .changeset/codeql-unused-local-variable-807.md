---
"awcms-mini": patch
---

Fix 2 open CodeQL `js/unused-local-variable` alerts (#52, #53) by closing the
real coverage gaps they flagged, instead of just deleting the unused import:

- `tests/integration/reference-data.integration.test.ts`: the imported
  `listValueSets` (`GET /api/v1/reference-data/value-sets`) handler was never
  called — the test titled "create, list, deprecate" only ever exercised the
  codes-within-a-value-set list, not the value-set-level list endpoint or its
  `status`/`scope` filters. Added assertions that the created value set
  appears in the list, and that `status=active`/`status=deprecated` correctly
  include/exclude it after deprecation.
- `tests/integration/integration-hub.integration.test.ts`: the imported
  `listSubscriptions` (`GET /api/v1/integration-hub/subscriptions`) handler
  was never called — the end-to-end worker-role test created a subscription
  and verified dispatch via raw SQL, but never exercised the real REST list
  endpoint. Added an assertion that the created subscription appears in the
  list with the correct `targetAdapterKey`.

No application code changed — test-only.
