---
"awcms-mini": minor
---

Add full SEO and social preview metadata for public news article sharing
(Issue #649, epic `news_portal` #631-#642/#649): `/news/{slug}` and
`/blog/{tenantCode}/{slug}` now render complete Open Graph metadata
(`og:type=article`, `og:image` with `og:image:secure_url`/`og:image:type`/
`og:image:width`/`og:image:height`/`og:image:alt`, `article:published_time`/
`article:modified_time`/`article:section`/`article:tag`), Twitter/X
`summary_large_image` Card metadata (including `twitter:image:alt`), a
`<meta name="robots">` directive (`index,follow,max-image-preview:large`
for public posts, `noindex,nofollow` for unlisted), and `NewsArticle`
JSON-LD structured data (headline/description/image/dates/author/publisher/
mainEntityOfPage), all safely escaped (including inside the JSON-LD
`<script>` tag).

The social/SEO preview image is resolved through a strict priority chain —
an explicit per-post SEO image override (new `seoImageMediaId` field),
then the featured image, then the first verified R2 image found in the
post's own content (if the tenant allows), then a tenant-level R2 fallback
image — every source re-verified against the existing R2-only media
registry (Issue #636) at render time; `og:image`/`twitter:image`/JSON-LD
`image` are always either a verified Cloudflare R2 object or omitted
entirely, never a local path or arbitrary external URL. Draft/private/
review/archived/soft-deleted/scheduled-future content never renders any of
this metadata (it 404s before rendering starts, unchanged from before).

The content quality checklist (Issue #640) gains two new advisory rules,
`social_preview_image_ready` and `social_preview_image_alt_text`, using the
exact same resolution chain the render route uses. RSS feeds and the news
sitemap now include the resolved preview image (`<enclosure>` /
`<image:image>`) when one is available.
