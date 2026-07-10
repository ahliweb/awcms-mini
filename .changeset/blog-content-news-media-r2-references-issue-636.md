---
"awcms-mini": minor
---

Require verified Cloudflare R2 media object references for `blog_content`
news images when full-online R2-only news portal mode is active for the
tenant (Issue #636, epic `news_portal`).

`featuredMediaId` and image gallery block items (`content_json`) now
must reference an existing, same-tenant, `verified`/`attached` media
object (Issue #633's registry) instead of a raw URL, whenever a tenant
has both the deployment env configured for the `news_portal_full_online_r2`
preset AND has genuinely applied that preset itself (tracked via a
dedicated per-tenant module-settings marker, not the shared
enabled/disabled module state every module already has by default — a
weaker signal would have let one tenant activating the preset silently
tighten validation for every other tenant on the same deployment). A
non-conforming reference is rejected with `422 NEWS_MEDIA_REFERENCE_INVALID`
at post/page create and update, and at revision restore, before
anything is written. Cross-tenant references, and references to
unverified/failed/orphaned/deleted objects, are always rejected in this
mode. Video gallery items and all behavior outside full-online R2-only
mode are unaffected.

The public post detail routes (`/news/{slug}`, `/blog/{tenantCode}/{slug}`)
now render gallery images and `og:image`/`twitter:image` meta tags from
resolved, verified R2 media metadata — an unresolved or unsafe reference
is silently omitted, never rendered.
