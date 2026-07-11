---
"awcms-mini": minor
---

Add an editorial homepage section composer for the `/news` public route
(Issue #637, epic `news_portal`).

Tenants can now configure ordered, schedulable homepage sections via
`POST/GET /api/v1/news-portal/homepage-sections` and
`PATCH/DELETE .../{id}` (also a new admin UI page,
`/admin/news-portal/homepage-sections`), of six types: `headline`,
`latest_posts`, `featured_posts`, `editor_picks`, `category_grid`, and
`gallery_block`. Every post/category/media reference in a section's
`config` must already exist for the same tenant, and — for
`gallery_block` — be a verified Cloudflare R2 media object (Issue
#633's registry); a non-conforming reference is rejected with
`422 HOMEPAGE_SECTION_REFERENCE_INVALID` before anything is written. A
tenant with no configured sections sees the exact pre-#637 `/news` page
— this is purely additive. At render time, every reference is
re-resolved against live data (a curated post that's since been
unpublished, or a category/media object that's since been removed,
silently disappears rather than erroring), and any rendered image
always comes from resolved, verified R2 media metadata via the
existing shared whitelisted renderer — never a raw or arbitrary image
URL.

`video_block`, `ad_slot`, `custom_widget_block`, and `static_page_block`
from the issue's suggested section list are deliberately not
implemented yet — they depend on surfaces (#638's R2-only ad images,
#639's video block) that don't exist, or are explicitly out of scope
(arbitrary HTML widgets), or would require a new public page-detail
route (`static_page_block`) that isn't otherwise needed. See the
`awcms-mini-news-portal` skill's §637 section for the full reasoning.
