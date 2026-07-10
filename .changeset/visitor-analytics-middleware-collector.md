---
"awcms-mini": minor
---

Wire visitor analytics collection into the request lifecycle (Issue #620,
epic: visitor analytics #617-#624). `src/middleware.ts` now collects
lightweight telemetry for `/admin/*` and public page requests (gated by
the Issue #617 config flags), writing to `awcms_mini_visitor_sessions`/
`awcms_mini_visit_events` via the new `application/collector.ts` service.
Fail-open (a collector error never breaks the real response), raw IP/UA
stay hashed unless explicitly opted in, and `identityId`/
`visitor_session_id` are always server-derived — never a client-supplied
value, closing the cross-tenant FK-oracle risk the Issue #618 security
audit flagged ahead of time. Adds migration `040` (session lookup index).
No API endpoints or dashboard UI yet — those land in Issues #621-#622.
