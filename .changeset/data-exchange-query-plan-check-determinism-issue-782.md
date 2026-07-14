---
"awcms-mini": patch
---

Fix a CI non-determinism in the `performance:query-plan:check` gate
(Issue #744/#782, epic `platform-evolution` #738) surfaced while landing
the `data_exchange` module (Issue #752): `scripts/performance-suite.ts`
and `scripts/performance-query-plan-check.ts` both seed independent
"safe"-scale synthetic fixtures into the same CI database with no reset
between them, so `awcms_mini_audit_events` accumulates roughly double a
single seed's row count by the time the query-plan budgets are
evaluated — whether that run observes the intended cost or the
inflated one then depends on PostgreSQL autovacuum's background
`ANALYZE` timing, not a deterministic measurement. Root-caused
empirically (including an identical reproduction on `main`, proving
this was never specific to `data_exchange`'s own code): the same
accumulated data costs ~11 immediately after seeding (stale,
pre-accumulation planner statistics) but ~1088-1132 once autovacuum
catches up. Added `resetPerformanceFixtureRows()`
(`src/lib/performance/fixture-seeder.ts`), scoped to only
`perf-*`-tagged synthetic fixture tenants, called by
`performance-query-plan-check.ts` before it reseeds — bounding
unbounded accumulation across repeated runs against a long-lived
database. Recalibrated the `audit-events-tenant-activity-reporting`
budget's `maxTotalCost` from 700 to 1300 in
`src/lib/performance/query-plan-budgets.ts` (with a fresh, dated
`approval` record) to reflect this query's real, timing-independent
cost — it is the one registered budget with no `LIMIT`, so unlike
every other budget its cost genuinely scales with the driving table's
accumulated physical size in this shared CI job structure, not just
one tenant's own row count.
