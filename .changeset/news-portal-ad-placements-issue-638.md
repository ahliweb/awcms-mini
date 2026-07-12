---
"awcms-mini": minor
---

Add R2-only advertisement placement presets for the news portal (Issue
#638, epic `news_portal`).

Tenants can now configure ads for twelve predefined placements
(`header_banner`, `below_headline`, `homepage_middle`,
`homepage_bottom`, `article_top`/`middle`/`bottom`,
`sidebar_top`/`middle`/`bottom`, `category_archive_top`,
`search_result_top`) via `POST/GET /api/v1/news-portal/ad-placements`
and `PATCH/DELETE .../{id}` (also a new admin UI page,
`/admin/news-portal/ad-placements`). Every ad's image must reference an
already-verified Cloudflare R2 media object (Issue #633's registry) —
there is no free-text image URL field at all, so a local path or
arbitrary external image can never be configured; a non-conforming or
cross-tenant reference is rejected with
`422 AD_PLACEMENT_REFERENCE_INVALID` before anything is written. An
optional (possibly external) link URL is validated server-side as an
absolute `http`/`https` URL only — `javascript:`/`data:`/relative
values are rejected. Inactive, not-yet-started, and expired ads are
excluded from rendering. Four rotation modes are supported (`latest`,
`priority`, `random_safe`, `weighted`), each capped to the placement's
configured maximum item count at render time. Rendering emits only a
whitelisted `<img>`/`<a>` fragment referencing the media registry's own
server-generated public URL — never raw script/embed markup.

This is a new table (`awcms_mini_news_portal_ad_placements`), separate
from `blog_content`'s existing free-URL `awcms_mini_blog_ads` — the
existing ads system is unchanged and remains available for tenants not
using the full-online R2-only news portal mode. See the
`awcms-mini-news-portal` skill's §638 section for the full reasoning.
