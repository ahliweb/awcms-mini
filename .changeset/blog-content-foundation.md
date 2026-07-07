---
"awcms-mini": minor
---

Add the `blog_content` module foundation (Issue #537, epic #536) — the
first domain module registered directly in this base repo (see
`docs/adr/0009-public-tenant-scoped-routes.md`). Adds `src/modules/blog-content`
(module descriptor, domain validation for content/slug/status/SEO/taxonomy
rules, read-only application query placeholders) and the core schema
(migrations `026`/`027`): tenant-scoped, RLS-`FORCE`d tables for posts,
pages, categories/tags, post-term relations, append-only revisions,
redirects, and per-tenant settings, plus the 26-entry `blog_content.*`
permission seed. No admin/public API, OpenAPI/AsyncAPI, or UI yet —
those land in Issues #538-#543.
