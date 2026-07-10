---
"awcms-mini": minor
---

Add the visitor analytics admin dashboard at `/admin/analytics` (Issue
#622, epic: visitor analytics #617-#624) — surfaces the `GET
/api/v1/analytics/*` endpoints shipped in #621 (realtime online counts,
24h/7d/30d human visitor summaries, top pages, device/browser
distribution, country/location summary, bot/suspicious traffic summary,
and a keyset-paginated active-sessions table) behind the module's own
`visitor_analytics.dashboard.read`/`.realtime.read`/`.sessions.read`
permissions.

The dashboard is UI-only: it adds no new endpoint, no new permission, and
never queries `awcms_mini_visitor_sessions`/`awcms_mini_visit_events`
directly — every number/table is loaded client-side from the existing
HTTP API (`fetchJson`, `src/lib/ui/admin-form-client.ts`), so server-side
ABAC remains the sole enforcement point. `visitor_analytics.raw_detail.read`
is never re-checked in the UI; the dashboard renders exactly what
`GET /api/v1/analytics/sessions` already shaped for the caller (a `null`
raw field renders as a placeholder, never a leaked value), and only
additionally hides the four raw-detail table columns as a presentation
nicety for callers who lack that permission.

The Location section is hidden with a safe "disabled" notice when
geolocation is not active for the deployment (`VISITOR_ANALYTICS_GEO_ENABLED`
+ `_TRUST_CLOUDFLARE`). The Area/Visitor-type filters narrow the
active-sessions table's already-fetched rows client-side (no aggregate
endpoint accepts those as query parameters); the Range filter
(`24h|7d|30d|12m`) re-fetches the range-scoped aggregate cards for real.

New pure view-model module
`src/modules/visitor-analytics/domain/dashboard-view.ts` (loading/empty/
error state resolution, raw-detail-null formatting) with its own unit
tests, plus two Playwright E2E specs covering access-denied and
aggregate-view-render/raw-detail-gating. i18n strings added for English
and Indonesian.
