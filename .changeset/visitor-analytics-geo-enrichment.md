---
"awcms-mini": minor
---

Add trusted online geolocation enrichment (Issue #623, epic: visitor
analytics #617-#624) — country code from Cloudflare's `CF-IPCountry`
header, gated behind both `VISITOR_ANALYTICS_GEO_ENABLED` and
`VISITOR_ANALYTICS_TRUST_CLOUDFLARE`, never an external network call.
`GET /api/v1/analytics/locations` now returns real data for deployments
that opt in. Also hardens `resolveAnalyticsClientIp` against ambiguous
multi-value `X-Forwarded-For`/`CF-Connecting-IP` headers (fail-safe with
a warning log, matching the tenant-domain-routing epic's
`X-Forwarded-Host` handling) and fixes a latent bug where
`user_agent_parsed`/`geo` jsonb columns were written via
`JSON.stringify(...)::jsonb`, which silently made every later read of
those columns return a raw JSON string instead of a parsed object.
