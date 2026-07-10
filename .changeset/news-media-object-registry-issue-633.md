---
"awcms-mini": minor
---

Add the R2-only news media object registry (Issue #633, epic
`news_portal` #631-#642/#649) — `awcms_mini_news_media_objects`
(migration `041`), tenant-scoped with `ENABLE`+`FORCE ROW LEVEL
SECURITY`, metadata-only (no binary columns), `storage_driver`
constrained to `cloudflare_r2`. Adds object-key generation/validation
and trusted public-URL construction
(`src/modules/news-portal/domain/news-media-object-key.ts`) plus
create/verify/attach/detach/soft-delete/restore/purge application
helpers with audit events
(`src/modules/news-portal/application/news-media-object-directory.ts`).
No upload endpoint yet (Issue #634) — permission key constants for it
are prepared (`domain/news-media-permissions.ts`) but not yet wired
into the module descriptor.
