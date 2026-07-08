---
"awcms-mini": minor
---

Add the tenant domain management API (Issue #562, epic #555):
authenticated, tenant-scoped, audited CRUD + lifecycle actions over
`awcms_mini_tenant_domains` under `/api/v1/tenant/domains` — the first
application code that writes rows to this table (previously only the
public host resolver, Issue #559, ever read from it).

```txt
GET    /api/v1/tenant/domains              list, keyset-paginated
POST   /api/v1/tenant/domains              create
GET    /api/v1/tenant/domains/{id}         read one
PATCH  /api/v1/tenant/domains/{id}         partial update
DELETE /api/v1/tenant/domains/{id}         soft delete
POST   /api/v1/tenant/domains/{id}/verify        manual-first verify
POST   /api/v1/tenant/domains/{id}/set-primary   atomic primary swap
```

Every route uses the standard ABAC guard
(`tenant_domain.domains.{read,create,update,delete,verify,set_primary}`,
migration 032's existing permission seed) and `withTenant` (RLS `FORCE`d
on the table since migration 031) — never the migration-033 `SECURITY
DEFINER` bootstrap function, which stays reserved for the anonymous
public resolver. `verify`/`set_primary` are new entries in
`identity-access/domain/access-control.ts`'s `AccessAction` union (not
added to `HIGH_RISK_ACTIONS`, same precedent as `retry`/`sync`/`enable`/
`disable`/`check`/`publish`) and both require `Idempotency-Key`.

Hostname validation reuses `normalizePublicHost()` (Issue #559) directly
rather than inventing a second hostname-shape opinion. A duplicate
normalized hostname (the underlying unique index is global, not
per-tenant) always returns a generic `409 HOSTNAME_CONFLICT` — never
reveals whether the existing mapping belongs to this tenant or another
one. Unknown/cross-tenant/soft-deleted domain ids all collapse to an
identical generic `404`. `hostname` is immutable after create; `is_primary`
is only ever settable via the atomic `set-primary` endpoint (two `UPDATE`s
in the same `withTenant` transaction, old-primary-unset then
new-primary-set, so the one-primary-per-tenant partial unique index is
never violated mid-transaction); `PATCH .../{id}` cannot set `status` to
`"active"` (only `POST .../verify` can, manual-first, no outbound DNS/HTTP
call). No response ever includes `verification_token_hash`.

Also fixes a timing side-channel flagged as a pre-`#562`-go-live blocker
in the `awcms-mini-tenant-domain-routing` skill:
`blog-content/application/public-news-tenant-resolution.ts`'s
`withNewsTenant()` used to cost a different number of DB round trips for
"tenant not resolved" (no transaction) versus "tenant resolved but
`blog_content` disabled" (opens a transaction + one module-check query),
even though both produce the identical generic 404 — an external prober
varying the `Host` header could have learned "this hostname maps to a
real active tenant" purely from response latency once this API lets
`awcms_mini_tenant_domains` hold real mappings. `padUnresolvedTenantLatency()`
now pays the same round-trip shape on the "not resolved" path (a harmless
padding query scoped to the all-zero fail-closed sentinel tenant id from
migration 013).

Post-review fix (security audit, Medium finding): `set-primary` now
catches a concurrent-first-primary race — two parallel `set-primary`
calls for a tenant that never had a primary before could both pass the
"unset old primary" step (nothing to unset) and race to "set new
primary," with the loser previously surfacing a raw
`awcms_mini_tenant_domains_primary_dedup` constraint-violation error
instead of a clean response. `setPrimaryTenantDomain` now catches that
violation and returns a generic `409 CONCURRENT_UPDATE`, mirroring the
existing hostname-dedup catch pattern in `createTenantDomain`. Covered by
a new parallel-request test in `tenant-domain-api.integration.test.ts`.

New files: `src/modules/tenant-domain/domain/tenant-domain-validation.ts`,
`src/modules/tenant-domain/application/tenant-domain-directory.ts`,
`src/pages/api/v1/tenant/domains/index.ts`,
`src/pages/api/v1/tenant/domains/[id].ts`,
`src/pages/api/v1/tenant/domains/[id]/verify.ts`,
`src/pages/api/v1/tenant/domains/[id]/set-primary.ts`. No new migration —
this issue is API-only over the existing migration 031/032 schema.
Covered by `tests/integration/tenant-domain-api.integration.test.ts` and
three new round-trip-counting tests in
`tests/integration/blog-content-public-news.integration.test.ts`.
