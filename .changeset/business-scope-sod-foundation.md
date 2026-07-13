---
"awcms-mini": minor
---

Add reusable business-scope assignments and segregation-of-duties (SoD)
policy hooks to `identity_access` (Issue #746, epic #738
`platform-evolution` Wave 2, ADR-0013 §2/§4).

- **Generic business-scope reference**: `awcms_mini_business_scope_assignments`
  (`sql/061`) grants a tenant user a role restricted to one
  `(scope_type, scope_id)` reference — never a foreign key to any
  optional module's table. Supports effective dates, temporary expiry,
  revocation, grantor/approver, and an append-only lifecycle history
  (`awcms_mini_business_scope_assignment_events`).
- **`BusinessScopeHierarchyPort`** (`src/modules/_shared/ports/
  business-scope-hierarchy-port.ts`) — capability port so a future
  optional organization module can resolve scope validity/ancestors/
  descendants without identity-access importing its tables. A default
  flat adapter (`identity-access/application/
  business-scope-hierarchy-port-adapter.ts`) resolves `scopeType: "office"`
  against `awcms_mini_offices` today; every other scope type is
  `resolved: false` (safe default, never a crash).
- **ABAC extension** (`domain/access-control.ts`) — additive optional
  `businessScopeFacts` parameter on `evaluateAccess` and
  `resourceAttributes.requiredScopeType`/`.requiredScopeId` convention on
  `AccessRequest`; every existing call site is unaffected. New
  `AccessAction` values `"revoke"` and `"override"`, both high-risk.
- **Static SoD rule registry** (`ModuleDescriptor.sodRules`,
  `src/modules/_shared/module-contract.ts`, `MODULE_CONTRACT_VERSION`
  1.0.0 → 1.1.0) — mirrors `data_lifecycle`'s lifecycle-registry
  pattern exactly. `bun run identity-access:sod-registry:check` (wired
  into `bun run check` **and** `.github/workflows/ci.yml`'s `quality`
  job as an explicit step). Three real rule fixtures: two owned by
  `identity_access` itself (exception request/approve maker-checker;
  assignment create/revoke at the same scope) and one contributed by
  `data_lifecycle` (`legal_hold.create`/`.release`, its own pre-existing
  permission pair).
- **Conflict enforcement wired at the real, shared chokepoint** —
  `access-guard.ts`'s `authorizeInTransaction` (used by the large
  majority of guarded endpoints, though a minority of pre-existing
  routes still call `evaluateAccess` directly and are not yet covered
  — see `high-risk-sod-guard.ts`'s header comment for the current
  scope) now runs SoD conflict evaluation for every high-risk decision
  on that path, reasoning over BOTH ordinary RBAC grants and active
  business-scope assignments. Proven against a real, unmodified
  endpoint (`POST /api/v1/data-lifecycle/legal-holds/{id}/release`) in
  `tests/integration/business-scope-sod-chokepoint.integration.test.ts`,
  not just a unit test of the pure conflict-detection function.
- **Temporary exception/override flow**
  (`awcms_mini_sod_conflict_exceptions`, `sql/061`) — bounded lifetime
  (no indefinite override), self-approval denied (re-checked from DB),
  automatic expiry via the scheduled job below.
- **Scheduled expiry job** — `bun run
  identity-access:business-scope:expiry` (hourly recommended), built on
  the shared worker runner, least-privilege `awcms_mini_worker` grants
  (`sql/061`), registered in `work-class-registry.ts`.
- **New API**: `GET`/`POST /api/v1/identity/business-scope/assignments`,
  `POST .../assignments/{id}/revoke`,
  `GET`/`POST /api/v1/identity/business-scope/exceptions`,
  `POST .../exceptions/{id}/{approve,reject,revoke}`,
  `GET /api/v1/identity/business-scope/conflicts` (keyset-paginated,
  safe projection). All mutations require `Idempotency-Key` and are
  audited.
- **New admin UI** — `/admin/business-scope` (assignments, exceptions,
  conflict history), permission-gated per section.
- **New metrics** — `business_scope_assignments_active`/`_temporary`,
  `business_scope_expirations_total`,
  `business_scope_cross_tenant_denied_total`,
  `sod_conflicts_detected_total`, `sod_exceptions_granted_total`.

Migrations `sql/061_awcms_mini_business_scope_assignments_schema.sql`
(four tenant-scoped, RLS FORCE'd tables) and
`sql/062_awcms_mini_business_scope_permissions.sql` (nine permissions).
Docs: `src/modules/identity-access/README.md`, updates to doc 04 (ERD),
doc 17 (RBAC/ABAC seed), doc 20 (threat model).
