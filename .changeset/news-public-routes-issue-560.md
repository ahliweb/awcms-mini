---
"awcms-mini": minor
---

Add public `/news` routes for `blog_content` (Issue #560, epic #555):
`src/pages/news/{index,[slug],category/[slug],tag/[slug],search,feed.xml,sitemap-news.xml}.ts`
— the tenant-code-free counterpart of `/blog/{tenantCode}` (ADR-0009,
still unchanged and unremoved). Reuses every existing public
application/domain service unchanged (`public-blog-directory.ts`,
`public-page-rendering.ts`, `seo-rendering.ts`, `content-block-rendering.ts`,
`blog-search.ts`'s `searchPublicBlogContent`, `error-responses.ts`); the
only difference is tenant resolution, via a new shared helper
`withNewsTenant()` (`src/modules/blog-content/application/public-news-tenant-resolution.ts`)
that calls `resolvePublicTenantFromRequest` (Issue #559) instead of
resolving from a `tenantCode` path segment, and additionally enforces a
module-disabled gate (`blog_content` disabled for the resolved tenant now
404s exactly like an unresolved tenant) — an explicit Issue #560
acceptance criterion that does not yet exist for the legacy
`/blog/{tenantCode}` routes (documented as a follow-up candidate, not
retrofitted here).

Also resolves an ambiguity flagged by two reviewers on Issue #559:
`resolvePublicTenantFromRequest()` (`src/lib/tenant/public-host-tenant-resolver.ts`)
now returns `null` unconditionally for `PUBLIC_TENANT_RESOLUTION_MODE=tenant_code_legacy`,
skipping the entire env/setup fallback chain instead of only the
host-lookup step — that mode means "no default tenant guess, every route
must carry its own `tenantCode`", which `/news` structurally cannot
satisfy. Leaving `PUBLIC_TENANT_RESOLUTION_MODE` unset (today's
offline/LAN default) is unaffected and still uses the full safe-fallback
chain.

Pure refactor, no behavior change for existing `/blog/{tenantCode}` call
sites: `public-page-rendering.ts`'s `renderPostSummaryListHtml` now
delegates to a new, more general `renderPostSummaryListHtmlAtBasePath`.
