---
"awcms-mini": minor
---

Add automatic internal tag linking for `blog_content` post/news content
(Issue #641, epic `news_portal`): matching tag names inside a published
post's rendered body are linked to the tag's canonical archive URL, as a
pure render-time transform of the already-safe renderer output — the
stored `content_json`/`content_text` are never mutated.

The renderer walks the real HTML element tree via Bun's built-in
`HTMLRewriter` (no new dependency) rather than regexing over a raw HTML
string — links are never inserted inside an existing anchor, script,
style, code/pre block, figure caption, embed element (`iframe`/`object`/
`embed`/`video`/`audio`), or (configurably) heading. Matching supports
exact and case-insensitive modes with Unicode-aware word boundaries (a
tag name is never matched as a substring of a larger word sharing the
same root, e.g. Indonesian "makan" inside "memakan"/"makanan"), longest-
match-first ordering when one tag name is a prefix of another, and two
independent caps (`maxPerTag`/`linkFirstOccurrenceOnly` and
`maxPerPost`).

Six deployment-wide `BLOG_AUTO_INTERNAL_TAG_LINKS_*` env vars (enabled
kill switch, max links per post/tag, minimum term length, first-
occurrence-only, exclude-headings) act as a ceiling; a new dedicated
per-tenant table (`awcms_mini_blog_internal_tag_link_settings`, its own
`GET`/`PATCH /api/v1/blog/internal-tag-links/settings` endpoint and
`blog_content.internal_links.{read,configure}` permissions — deliberately
NOT folded into `awcms_mini_blog_settings`, see that migration's header)
lets a tenant disable the feature entirely, enable case-insensitive
matching, and disable specific tags. A new
`auto_internal_tag_links_disabled` column on `awcms_mini_blog_posts`
supports a manual per-post opt-out. A new read-only preview endpoint,
`GET /api/v1/blog/posts/{id}/internal-links/preview`
(`blog_content.internal_links.preview`), shows which terms would be
linked before publishing, reusing the exact same resolution/rendering
path the public routes use.

Wired into both public post-detail routes (`/news/{slug}` and
`/blog/{tenantCode}/{slug}`) — tag candidates are always queried
tenant-scoped, so a tag can never be linked across tenants. Config
changes are audit-logged.
