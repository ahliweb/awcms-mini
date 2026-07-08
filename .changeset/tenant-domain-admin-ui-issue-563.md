---
"awcms-mini": minor
---

Add the tenant domain/subdomain admin UI (Issue #563, epic #555):
`src/pages/admin/tenant/domains.astro`, at the path/permission already
declared by the module descriptor (Issue #558) —
`/admin/tenant/domains`, gated on `tenant_domain.domains.read`.

List, add platform subdomain/custom domain, show/copy TXT/CNAME
verification records, trigger manual-first verify, set primary domain,
soft delete, and preview the public `/news` link for a domain that is
both `active` and the tenant's primary. Status badges use the real DB
enum (`pending_verification | active | suspended | failed`, migration
031) rather than the issue's own shorthand list.

SSR reads (`listTenantDomains`) are a direct, read-only DB call inside
`withTenant` — the same convention `admin/blog/categories.astro` uses.
**Every mutation** (create/update/verify/set-primary/delete) goes through
the real `/api/v1/tenant/domains/**` endpoints (Issue #562) via
client-side `fetch` — no privileged SSR shortcut. `verify`/`set-primary`
send a fresh `Idempotency-Key` (`crypto.randomUUID()`) per click, matching
`admin/blog/posts/[id].astro`'s lifecycle-action buttons; every mutating
control is `lockElement`-guarded against double-submit. Hostname
validation is duplicated client-side as a UX nicety only (mirrors
`normalizePublicHost()`'s shape rules) — the API remains the enforcement
boundary.

Extends `src/lib/i18n/error-messages.ts`'s `ERROR_CODE_KEYS` with the
tenant domain API's own `HOSTNAME_CONFLICT`, `INVALID_STATUS_TRANSITION`,
and `CONCURRENT_UPDATE` codes so the admin UI never surfaces a raw
server message for them. `src/modules/tenant-domain/domain/tenant-domain-validation.ts`
now exports its enum vocabulary arrays (`TENANT_DOMAIN_TYPES` etc.) so the
create/edit forms build their `<select>` options from the same source of
truth the validator itself uses, instead of a second opinion.

New i18n catalog entries under `admin.tenant_domain.*` and
`admin.layout.nav_tenant_domains` (en + id). New test:
`tests/integration/tenant-domain-admin.integration.test.ts` — the SSR
read path's empty/populated/active-primary/tenant-isolation shapes, and
that the three new error codes are ones the real API actually returns.

Post-review fix: the edit form's status `<select>` was previously hidden
entirely for an `active` domain, leaving no self-service way to suspend a
live domain from this screen (the API already allowed `active ->
suspended`/`failed` via `PATCH`, since Issue #562 never gated that
transition on current status). The status field now always renders, with
a "leave unchanged" default option (wiring up a catalog entry the first
draft had added but never used) plus a hint explaining the consequence
when the current status is `active`. Also removed a native HTML `pattern`
attribute on the create form's hostname input that could block submission
with the browser's untranslated tooltip before the app's own localized
error banner (`looksLikeValidHostname()`) ever ran — the client-side
check remains a UX nicety only; `normalizePublicHost()` via the API stays
the enforcement boundary.
