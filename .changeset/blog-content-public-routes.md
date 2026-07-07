---
"awcms-mini": minor
---

Add public (anonymous, no session) blog routes to the `blog_content`
module (Issue #540, epic #536): blog index, post detail, category/tag
archives, search, RSS feed, and sitemap, all under
`/blog/{tenantCode}/...` per ADR-0009's tenant-resolution pattern. Every
route enforces the public visibility predicate (published, not deleted,
`published_at` in the past) — listing surfaces additionally require
`visibility = 'public'` while post detail also allows `unlisted` (direct
link only, never listed). Post body content renders through a new
whitelist block renderer (`content_json`'s first concretely defined
schema: paragraph/heading/list/quote) that only ever emits escaped text,
never raw HTML. SEO title/description/canonical URL render with documented
fallbacks and re-validated URL safety. Errors never leak a stack trace —
every route returns a fixed generic error page/XML on failure. Adds a
reusable `resolvePublicTenantByCode` helper (`src/lib/tenant/`) and shared
HTML/XML escaping and error-response helpers (`src/lib/html/`) for future
public routes to reuse.
