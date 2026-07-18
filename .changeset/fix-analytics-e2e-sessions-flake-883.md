---
"awcms-mini": patch
---

test(e2e): fix admin-analytics sessions-table flake via reload-poll (#883)

`admin-analytics-dashboard.e2e.ts` asserted a sessions-table row on a table
populated by a single client-side fetch (`loadSessionsPage(null)`) that races
the deferred visitor-telemetry write (~200ms per-tenant batcher linger,
#832/#846). With no client re-fetch, a fixed `toBeVisible` wait could never
recover once that fetch resolved empty, so the assertion failed ~100% on fast
CI and blocked the merge queue. The one-shot wait is replaced with a bounded
reload-poll that re-runs the fetch — a re-query, not a longer timeout — so the
assertion is deterministic while still proving a real, middleware-collected
session row is visible. Test-only; no runtime/product change.
