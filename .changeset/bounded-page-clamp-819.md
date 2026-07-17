---
"awcms-mini": patch
---

fix(blog-content): clamp `?page=` at both ends on public blog/news routes (Issue #819)

`boundedPage` clamped only the lower bound and did not guard `NaN`, on routes
that are public and unauthenticated. `?page=1e8` reached `OFFSET 1e9` (a
deep-offset scan holding a pool connection for one credential-less GET) and
`?page=abc` reached `OFFSET NaN` → 500.

Page-number bounds now live in a shared helper
(`src/modules/_shared/offset-pagination.ts`): `boundedPageNumber` clamps to
`[1, 10_000]`, truncates fractions, and returns page 1 for `NaN`/`±Infinity`;
`parsePageParam` is used by the six public `/blog/{tenantCode}` and `/news`
routes so the clamped value is also what renders into pagination nav links.
The admin blog post/page lists use the same helper (they shared the
copy-pasted pattern).

Behaviour change: a non-numeric or out-of-range `?page=` now renders page 1
(or an empty page 10,000) instead of a 500.
