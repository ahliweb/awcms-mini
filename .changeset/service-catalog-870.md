---
"awcms-mini": minor
---

feat(service-catalog): versioned SaaS plans, features, quotas, pricing, and offer lifecycle (#870)

Adds `service_catalog`, the first SaaS control-plane module (epic #868, Wave 1,
ADR-0022) — Official Optional Business Foundation, opt-in per tenant,
**default-disabled**. Provider-neutral versioned commercial plans with an
immutable-once-published offer lifecycle (draft -> validate -> publish ->
retire), feature/whole-module entitlement grants, usage quotas (unit + reset
policy), EXACT minor-unit prices (no floating point), and trial/availability/
market/currency metadata.

Migrations 079/080 add six GLOBAL control-plane tables split into an
operator-only authoring tier and a tenant-readable published projection (only
published versions + public prices — internal prices/draft data never cross the
tenant boundary, ADR-0022 §3 Medium-1), with DB-level immutability triggers and
least-privilege grants. Exposes bounded list/detail/create/update/version/
validate/publish/retire APIs (OpenAPI), emits versioned domain events
(`awcms-mini.service-catalog.offer.{published,retired}`, AsyncAPI), and ships an
admin UI (draft/published state, version history, validation errors) with en/id
i18n. publish/retire require Idempotency-Key + audit.

This module also lands two foundations reused by #871-#877:

- **Default-disabled mechanism + gate.** New `ModuleDescriptor.defaultTenantState`
  + `isModuleTenantEnabledByDefault`, read by every runtime resolver
  (`resolveModuleEnabled`, the SSR permission gate, the nav registry, the
  tenant-module matrix), so a control-plane module with no explicit
  `awcms_mini_tenant_modules` row resolves disabled. Enforced by
  `tests/unit/module-governance-default-disabled.test.ts`. MINOR-additive
  module-contract change (version 1.3.0); every other module is unaffected.
- **Control-plane <-> tenant-plane boundary test** in
  `tests/unit/module-boundary.test.ts` (no reverse dependency into
  service_catalog internals, no-shared-table-write, read-only capability port).
