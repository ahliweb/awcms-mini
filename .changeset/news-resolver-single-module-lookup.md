---
"awcms-mini": patch
---

Narrow the read surface of the anonymous public `/news` module-enabled
gate, closing a non-blocking follow-up from the epic #555 security audit
chain (found auditing Issue #560, tracked in
`.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` as a
"consider as an optional narrowing" item — not a real DoS risk, but
unnecessary read surface for an unauthenticated code path).

`blog-content`'s `public-news-tenant-resolution.ts` only needs
`blog_content`'s own tenant-enabled state, but was calling
`fetchTenantModuleEntries` — which reads every registered module's row
for the tenant and filters in memory — to get it.

Added `fetchTenantModuleEntry(tx, tenantId, moduleKey)` to
`module-management/application/tenant-module-lifecycle.ts`: a
single-module narrowing that filters `module_key` in the `SQL` itself,
returning `null` only if `moduleKey` isn't a registered descriptor.
Same opt-out-by-default semantics as the existing plural function (no
`awcms_mini_tenant_modules` row means `tenantEnabled: true`).
`fetchTenantModuleEntries` (plural) is unchanged and still used by its
three other consumers that genuinely need the full list: the
`GET /api/v1/tenant/modules` endpoint, tenant module presets, and the
tenant-module matrix admin UI.

`checkBlogContentAndRouteGate` (the one function both the real `/news`
resolve path and the Issue #562 timing-parity padding path call) now
uses the singular lookup — since both paths share this one function,
the round-trip count for the module-enabled check stays identical (a
single query either way), so the existing timing-parity guarantee is
unaffected.

New test: `tests/integration/module-tenant-lifecycle.integration.test.ts`'s
"fetchTenantModuleEntry ... matches the plural function's per-entry
result before and after a real disable" (also covers the unknown-module
-> `null` case). The pre-existing round-trip-parity tests in
`tests/integration/blog-content-public-news.integration.test.ts` pass
unchanged, confirming the query-count parity holds with the new
function.
