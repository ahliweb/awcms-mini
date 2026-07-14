---
"awcms-mini": patch
---

Wire `organization_structure`'s real `BusinessScopeHierarchyPort` adapter (`organizationStructureHierarchyPortAdapter`, Issue #749) into its actual production consumer, `POST /api/v1/identity/business-scope/assignments` (Issue #786, follow-up to #746/#749, epic `platform-evolution` #738). Previously this route hardcoded only `identity_access`'s own flat `"office"` default adapter, so `legal_entity`/`organization_unit` business-scope references always resolved as `SCOPE_UNRESOLVED` even when the referenced row genuinely existed — the reviewer's non-blocking follow-up note on PR #779.

- The route's `buildHierarchyPort` now resolves `organization_structure`'s per-tenant enablement (`resolveModuleEnabled`) and, when enabled, tries the real adapter first for every scope, falling back to the flat `"office"` adapter when it doesn't resolve (any other scope type, or every scope type when the module is disabled for that tenant).
- Wiring lives entirely in the route file (a composition root), never inside `identity_access`'s own `application`/`domain` tree — keeps Core free of any compile-time import of the Optional `organization_structure` module (ADR-0013 §1), verified by `tests/unit/module-boundary-cycles.test.ts`.
- `identity_access/module.ts` now declares `capabilities.consumes` for `organization_hierarchy_resolution` (`providedBy: "organization_structure"`, `optional: true`), matching `organization_structure`'s own declared `capabilities.provides` for the module-composition validator.
- New integration coverage (`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`): real `legal_entity`/`organization_unit` scope resolution end-to-end through the real adapter, tenant isolation, a same-scope SoD conflict check that is only reachable once the real adapter validates the scope, and the flat-adapter fallback (both for `organization_structure`'s own scope types and for `"office"`) when the module is disabled for a tenant.

Scope note: this fixes scope EXISTENCE/validity resolution — SoD conflict matching (`same_scope_only`) still compares `(scopeType, scopeId)` by exact equality and does not yet consult ancestor/descendant hierarchy chains; that remains a distinct, not-yet-built feature.
