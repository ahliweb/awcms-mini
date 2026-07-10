---
"awcms-mini": minor
---

Add the `visitor_analytics` module foundation (Issue #617, epic: visitor
analytics #617-#624) — a new `type: "system"` module (like
`reporting`/`logging`) for privacy-first human visitor statistics. Adds
`src/modules/visitor-analytics` (module descriptor, env-based
configuration gate with `basic`/`detailed` modes, all raw-detail/geo
collection disabled by default), the 8-entry `visitor_analytics.*`
permission seed (migration `038`), and `checkVisitorAnalyticsConfig` in
`bun run config:validate`. No analytics tables, middleware collector,
API, dashboard UI, geolocation enrichment, or rollup/retention jobs yet —
those land in Issues #618-#624.
