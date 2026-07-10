---
"awcms-mini": minor
---

Add the visitor analytics rollup job, retention purge job, readiness
checks, and closing documentation (Issue #624, epic: visitor analytics
#617-#624 — the final issue in the epic).

`bun run analytics:rollup` (`scripts/visitor-analytics-rollup.ts`)
aggregates `awcms_mini_visit_events` into `awcms_mini_visitor_daily_rollups`,
one row per `(tenant, date, area)`, for every active tenant. It is
idempotent by construction: each run fully recomputes a date's totals
from raw events and UPSERTs (`ON CONFLICT ... DO UPDATE SET ... =
EXCLUDED...`), so rerunning the same date never double-counts. CLI
accepts `--date=YYYY-MM-DD`, `--start-date=.../--end-date=...` for
backfill, or defaults to "yesterday" (UTC).

`bun run analytics:purge` (`scripts/visitor-analytics-purge.ts`) iterates
every active tenant and calls the existing `purgeVisitorAnalyticsData`
(Issue #621) directly — the same function `POST
/api/v1/analytics/retention/purge` already uses on demand — rather than
re-deriving its four retention cutoffs. Only a tenant where the purge
actually deleted/cleared something gets a `critical` `retention_purged`
audit event (safe summary counts only, never raw data).

`bun run security:readiness` gains five new cross-field checks:
`checkVisitorAnalyticsRawIpRetentionReady` (critical — raw IP enabled
with unsafe retention ordering), `checkVisitorAnalyticsRawUserAgentRetentionReady`
(warning), `checkVisitorAnalyticsGeoTrustedSourceReady` (critical — geo
enabled without a trusted Cloudflare source), `checkVisitorAnalyticsRetentionOrderingReady`
(warning — general raw-detail/rollup retention ordering), and
`checkVisitorAnalyticsHashSaltReady` (warning — empty hash salt while
the module is active). Every check passes cleanly on the privacy-first
default configuration (nothing set); only `critical` findings block
go-live.

New `docs/awcms-mini/visitor-analytics.md` documents offline/LAN, full-online,
and trusted-proxy/Cloudflare operating modes, the per-column retention
policy, rollup/purge job behavior, and a practical compliance mapping to
UU PDP, PP PSTE, ISO/IEC 27001/27002/27005/27701, OWASP ASVS, and the
OWASP Logging Cheat Sheet. `18_configuration_env_reference.md`,
`deployment-profiles.md`, `20_threat_model_security_architecture.md`, and
`04_erd_data_dictionary.md` are updated to match. With this issue, the
visitor analytics epic (#617-#624) is complete.
