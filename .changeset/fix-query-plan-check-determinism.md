---
"awcms-mini": patch
---

fix(performance): make the query-plan budget check independent of table residue

`analyzeQueryPlanFixtures` ran a bare `ANALYZE`, which refreshes statistics but
not the dead space the fixture reset (`DELETE`, the only write the app role has)
leaves behind. Heap-bound plans are costed by page count, so on identical rows
the audit reporting aggregate planned as Seq Scan (1646, over its budget) or
Bitmap Heap Scan (530 to 2306) and blog full-text search cost 471.9 to 931.1
against an 800 ceiling, depending on what earlier tests and runs had left in the
tables. It now runs `VACUUM (FULL, ANALYZE)` through the same owner connection
(still behind the non-production target guard, and `analyze_count` is still
verified), after which the costs are identical across consecutive runs. No
budget, ceiling or forbidden node type was changed.
