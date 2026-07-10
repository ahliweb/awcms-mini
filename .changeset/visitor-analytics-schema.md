---
"awcms-mini": minor
---

Add the visitor analytics database schema (Issue #618, epic: visitor
analytics #617-#624) — `awcms_mini_visitor_sessions`,
`awcms_mini_visit_events`, and `awcms_mini_visitor_daily_rollups`
(migration `039`), all tenant-scoped with `ENABLE`+`FORCE ROW LEVEL
SECURITY`. Raw IP/user-agent columns are nullable and unused by default;
no writer exists yet (the middleware collector lands in Issue #620).
