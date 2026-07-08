---
"awcms-mini": minor
---

Add tenant-scoped `blog_content` settings for public route behavior
(Issue #564, epic #555): `module.ts`'s descriptor now declares
`settings.defaults` (`publicRouteMode: "domain_default"`,
`publicBasePath: "/news"`, `legacyTenantRouteEnabled: true`,
`publicLabel: "News"`), read/written through Module Management's existing
generic tenant-settings framework (`GET`/`PATCH
/api/v1/tenant/modules/blog_content/settings`, Issue #516/epic #510) — no
new endpoint, no new table.

Deliberately does **not** add `rssEnabled`/`sitemapEnabled` to this new
store, even though the issue's own example JSON lists them alongside the
four new keys: those two flags already work end to end via
`awcms_mini_blog_settings` (Issue #537/#543) and stay there — duplicating
them into a second, independently-writable store would create two
disconnected sources of truth for the same concept. A new merge helper,
`application/public-route-settings.ts`'s `fetchEffectivePublicRouteSettings`,
reads from both stores for route-handler convenience without owning
either.

Behavior added:

- `/news` route handlers (all seven) now read
  `publicRouteMode`/`publicBasePath`/`publicLabel` from effective settings.
  `publicRouteMode=disabled` collapses every `/news` route to the same
  generic 404 an unresolved tenant already produces (timing-parity
  preserved — `withNewsTenant`'s module-disabled gate and
  `padUnresolvedTenantLatency` now share one `checkBlogContentAndRouteGate`
  function so they can't drift). `publicBasePath` (falling back to the
  `PUBLIC_CANONICAL_BASE_PATH` env var, Issue #556, previously validated
  but unconsumed) now drives self-referential link generation (canonical
  URL, RSS/sitemap links, cross-links) — it does not retarget which Astro
  file route physically serves the request, a documented, deliberate
  limitation (see README §Public route settings).
- All seven `/blog/{tenantCode}` legacy routes now respect
  `legacyTenantRouteEnabled`; `false` 404s all of them (disable, not
  redirect — documented choice), consistently. Default `true` keeps
  today's behavior unchanged.

New test: `tests/integration/blog-content-settings.integration.test.ts`
(14 tests, including a regression test proving `publicLabel`/
`publicBasePath` — free-form, tenant-admin-writable strings — are
HTML/XML-escaped everywhere they're rendered into `/news` output, no
stored-injection). Post-review addition: a fourth round-trip-parity test
in `blog-content-public-news.integration.test.ts` explicitly compares
`publicRouteMode=disabled`'s cost against the enabled path, closing a
gap the security audit flagged (parity held structurally already, now
also asserted directly rather than only inferred).
