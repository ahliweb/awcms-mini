---
"awcms-mini": minor
---

Add the tenant-module matrix admin UI (Issue #566, epic #555, depends on
#565): `src/pages/admin/modules/tenants.astro`, at the path already used
by the issue (`/admin/modules/tenants`), gated on **both**
`module_management.modules.read` and `module_management.tenant_modules.read`.

**Single-tenant scope, not cross-tenant** (decided with the maintainer,
documented in full in the page's own docblock and
`module-management/README.md`): this repo's identity model is strictly
1:1 tenant-scoped, so this screen shows module x relevant-attribute for
the admin's own tenant only — there is no tenant selector/filter anywhere
on this page.

What the matrix adds beyond the existing `/admin/modules` list +
`/admin/modules/{moduleKey}` detail pages: dependency and
reverse-dependency warnings surfaced for every module at once (100%
reuse of `evaluateModuleEnable`/`evaluateModuleDisable`, no re-derived
graph logic — new `application/module-matrix.ts`'s `fetchModuleMatrix`),
bulk core/protected visualization (`isCore` plus Issue #565's
`resolveProtectedModuleKeys`, with the disable control hidden for both),
and a client-side "only show modules with a warning" filter. Settings
editing and the audit-event list are not duplicated — this screen links
to the existing detail page for both. Applying a module preset
(`applyModulePreset`, #565) was considered but left out of this issue —
doing so cleanly needs a new guarded/audited API endpoint, a separable
unit of work — and is noted as a follow-up.

SSR reads (`fetchModuleMatrix`) are a direct, read-only DB call inside
`withTenant`. Every mutation (enable/disable) goes through the real
`/api/v1/tenant/modules/{moduleKey}/enable|disable` endpoints (Issue
#515) via client-side `fetch` — no privileged SSR shortcut, same binding
split `admin/tenant/domains.astro` (#563) established. Neither endpoint
requires an `Idempotency-Key`; disable prompts for a reason via
`window.prompt`, matching `admin/modules/[moduleKey].astro`'s existing
enable/disable buttons exactly.

New i18n catalog entries under `admin.modules.matrix_*` plus
`admin.layout.nav_module_matrix` (en + id) — the module descriptor's
`navigation` array gained a second entry for this page. New test:
`tests/integration/module-tenant-matrix.integration.test.ts` — covers
`fetchModuleMatrix`'s health-inclusion toggle, both warning directions
(using the same registry scenarios
`module-tenant-lifecycle.integration.test.ts` already established), core
protection, real enable/disable mutations with audit-event assertions,
and a 403 for a caller without `module_management.tenant_modules`
permissions.
