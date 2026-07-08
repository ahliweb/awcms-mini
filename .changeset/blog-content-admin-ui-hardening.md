---
"awcms-mini": minor
---

Add the full admin UI, blog settings API, and final hardening for the
`blog_content` module (Issue #543, epic #536 — closing the epic). New
screens under `/admin/blog` (dashboard, posts list/editor with lifecycle
actions and revision history, pages list/editor, categories, tags,
settings, and optional templates/widgets/menus/ads managers), all Astro +
vanilla JS reusing the existing `AdminLayout`/design tokens, with loading/
empty/error/ready states, double-submit prevention, and confirm-then-
`Idempotency-Key` on every high-risk action. New `GET`/`PATCH
/api/v1/blog/settings` endpoint activates `awcms_mini_blog_settings`
(schema present since migration 026, unwired until now), publishing
`blog-content.settings.updated` — the module's AsyncAPI contract's last
producer-less channel. RSS feed and sitemap now respect the new
`rssEnabled`/`sitemapEnabled` settings (404 when disabled, indistinguishable
from an unknown tenant). `module.ts` now declares its full `permissions`
(36 entries, matching migrations 027/030) and `navigation` (`/admin/blog`)
arrays, previously empty despite the permissions already existing in the
database. No schema changes.
