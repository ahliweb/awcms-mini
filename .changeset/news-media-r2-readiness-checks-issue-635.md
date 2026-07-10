---
"awcms-mini": minor
---

Add Cloudflare R2 image delivery readiness checks for the news portal's
R2-only media mode (Issue #635, epic `news_portal` #631-#642/#649).

`bun run config:validate` now rejects a `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES`
allow-list containing any type outside the ones the MIME sniffer can
actually recognize (JPEG/PNG/WebP/GIF/SVG — an unrecognized entry can
never pass upload verification, so it is a misconfiguration, not just an
unsafe default), and rejects a
`NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS` above 3600 seconds (a
presigned PUT URL is reusable for its whole TTL, so an excessive expiry
weakens that mitigation).

`bun run security:readiness` adds two checks: a critical check that,
when `APP_ENV=production`, rejects a `NEWS_MEDIA_R2_PUBLIC_BASE_URL`
pointing at Cloudflare's default `*.r2.dev` domain or a loopback host
(production must use a real custom domain — non-production is
unaffected, by design); and a warning check that scans all tenants for
`awcms_mini_news_media_objects` rows stuck in `pending_upload` past
`NEWS_MEDIA_R2_PENDING_TTL_MINUTES`, surfacing that the automatic
cleanup job this mode's architecture document describes has not been
implemented yet.
