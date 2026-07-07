---
"awcms-mini": minor
---

Add pages, taxonomies, post-term relations, and PostgreSQL full-text
search to the `blog_content` module (Issue #539, epic #536): tenant-scoped
page CRUD (`/api/v1/blog/pages`), category/tag CRUD with parent-child
hierarchy and tag-rejects-parent enforcement (`/api/v1/blog/terms`),
post-term assignment via `termIds` on the existing blog post API, and
admin full-text search (`/api/v1/blog/search`, keyset-paginated) across
posts and pages. `search_vector` on posts/pages is now a
`GENERATED ALWAYS ... STORED` column (migration 028) instead of an unused
plain column. Pages reuse the same author-own-unpublished-content ABAC
override posts introduced in Issue #538, now factored into a shared
`evaluateContentUpdateAccess`. A public-safe search helper is included for
Issue #540's public routes to consume — no public route yet in this
issue.
