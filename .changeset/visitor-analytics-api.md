---
"awcms-mini": minor
---

Add the visitor analytics REST API (Issue #621, epic: visitor analytics
#617-#624) — eleven endpoints under `/api/v1/analytics` for realtime
presence, range-bounded summary/pages/devices/locations/security
aggregates, keyset-paginated sessions/events, settings, and on-demand
retention purge. Every endpoint enforces ABAC default-deny; raw IP/
user-agent/login-identifier detail on sessions/events is gated behind the
separate `visitor_analytics.raw_detail.read` permission, independent of
`sessions.read`/`events.read`. Retention purge requires an
`Idempotency-Key` and is recorded as a `critical` audit event. OpenAPI
contract updated with all new paths, schemas, and error responses.
