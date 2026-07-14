# organization_structure

Optional, tenant-scoped organization-structure foundation (Issue #749, epic
`platform-evolution` #738 Wave 2, `docs/adr/0016-organization-structure-module-admission.md`
admission decision, `docs/adr/0013-extension-layers-and-boundary-model.md`
§2/§4 tenant vs legal entity vs organization unit vocabulary). Admitted as
an **Official Optional Business Foundation** module — opt-in per tenant,
generic across every derived application, never an ERP implementation.

## What this module is

- **Legal entities** (`awcms_mini_legal_entities`) — tenant-scoped
  business/legal entity (e.g. one PT/CV), generic opaque registration
  identifier pair (`registration_identifier` + `registration_identifier_label`
  — never a government-specific field like NPWP/SIUP), status, effective
  dates, soft-delete/deactivate only.
- **Organization-unit types** (`awcms_mini_organization_unit_types`) —
  tenant-configurable typed vocabulary. Suggested seed examples
  (`domain/organization-unit-type.ts`'s `DEFAULT_UNIT_TYPE_SEEDS`, never
  auto-inserted): `department`, `branch`, `cost_center`, `warehouse`,
  `program_unit`.
- **Organization units** (`awcms_mini_organization_units`) — effective-dated,
  optionally linked to a legal entity (never required — a unit directly
  under the tenant is explicitly allowed) and optionally typed.
- **Hierarchy** (`awcms_mini_organization_unit_hierarchies`) — versioned/
  effective-dated (SCD Type 2 style) parent-child edges. Reparenting NEVER
  mutates a `parent_organization_unit_id` column in place — it closes the
  current open edge (`effective_to = now()`) and opens a new one. No-cycle/
  self-parent validation runs transactionally in
  `application/organization-unit-hierarchy-service.ts`'s `reparentUnit`,
  the SOLE write path against this table, guarded by a tenant-wide
  `pg_advisory_xact_lock` (closes the cross-row concurrent-reparent race)
  plus a `SELECT ... FOR UPDATE` on the unit's own current edge row.
- **Operational locations** (`awcms_mini_operational_locations`) — optional
  address fields, optional lat/lng validated to `[-90,90]`/`[-180,180]`.
- **Location-to-unit relationships** (`awcms_mini_location_unit_relationships`)
  — explicit many-to-many join table, itself effective-dated.
- **Assignments** (`awcms_mini_organization_unit_assignments`) — effective-
  dated assignment of an `identity_access` tenant user to a unit, with an
  optional plain-string `position_label` (explicitly NOT an HR/payroll
  hierarchy). References `awcms_mini_tenant_users` via an ordinary FK,
  re-validated tenant-scoped at write time — never a duplicate person/party
  registry (ADR-0013 §4).

## What this module is NOT

- Not a tenant — legal entity/organization unit are business/accounting
  groupings **inside** one tenant, never an RLS boundary (ADR-0013 §2).
  Every table's RLS predicate is always and only `tenant_id`.
- Not an ERP — no chart of accounts, inventory/warehouse stock valuation,
  HR, payroll, tax, or government-specific organization rules.
- Not tenant provisioning/subscription management (that is SaaS Control
  Plane territory, ADR-0013 §1/§3 — out of base scope entirely).

## Capability port: `BusinessScopeHierarchyPort`

This module provides a REAL adapter
(`application/organization-structure-hierarchy-port-adapter.ts`,
`organizationStructureHierarchyPortAdapter`) implementing
`_shared/ports/business-scope-hierarchy-port.ts`'s
`BusinessScopeHierarchyPort` for `scopeType` `"legal_entity"` and
`"organization_unit"` — read-only, tenant-scoped, RLS-respecting, walking
the real effective-dated hierarchy as of "now". It does **not** supersede
`identity-access`'s own flat default adapter
(`defaultBusinessScopeHierarchyPortAdapter`, which only handles
`"office"`) — the two coexist. `identity_access` has **no** lifecycle or
capability dependency on `organization_structure` in either direction
(Core never depends on Optional, ADR-0013 §1).

**Wired end-to-end since Issue #786** (this module shipped the adapter in
#749 but had zero production callers until this follow-up). The real
composition root — `POST /api/v1/identity/business-scope/assignments`'s
`buildHierarchyPort` (`src/pages/api/v1/identity/business-scope/
assignments/index.ts`) — checks whether `organization_structure` is
enabled for the calling tenant (`resolveModuleEnabled`) and, when it is,
tries this module's real adapter FIRST for every scope, falling back to
identity-access's flat `"office"` adapter when this one doesn't resolve
the scope (any scope type it doesn't own, or ANY scope type at all when
the tenant has this module disabled). No file inside `identity_access`'s
own `application`/`domain` tree imports anything from
`organization_structure` — the wiring lives entirely in the route file, a
composition root outside every module's own `application`/`domain` tree,
which is what keeps `tests/unit/module-boundary-cycles.test.ts` (Core/
Optional import-cycle guard) passing. This module's own
`capabilities: { provides: ["organization_hierarchy_resolution"] }`
(`module.ts`) is matched by `identity_access/module.ts`'s
`capabilities.consumes` entry (`optional: true`) for the module-
composition validator (Issue #740) — a documentation/build-time-validation
declaration, not the runtime wiring itself.

`"location"` (physical location lookup) is deliberately **not** exposed
through this port — the port is about business-scope authorization/
hierarchy resolution, not physical location lookup (see ADR-0016 §10).

## Events

Published to `asyncapi/awcms-mini-domain-events.asyncapi.yaml` AND
integrated with `domain_event_runtime` (Issue #742) as a REAL producer
(same pattern as `workflow_approval`, Issue #747) — every write in
`application/*.ts` calls `appendDomainEvent` inside the SAME transaction as
the state change:

- `awcms-mini.organization-structure.legal-entity.{created,updated,deactivated}`
- `awcms-mini.organization-structure.unit.{created,updated,deactivated}`
- `awcms-mini.organization-structure.hierarchy.changed`
- `awcms-mini.organization-structure.assignment.{created,ended}`

## Metrics

`bun run organization-structure:metrics-snapshot` (read-only, safe in every
deployment profile) samples, per active tenant:

- `organization_structure_active_units_total` (gauge)
- `organization_structure_hierarchy_max_depth` (gauge)
- `organization_structure_assignments_expiring_total` (gauge — near-term
  expiring-soon window, default 30 days, `domain/organization-unit-
assignment.ts`'s `DEFAULT_EXPIRING_SOON_WINDOW_DAYS`; a metric only, no
  auto-expiry action)

`organization_structure_hierarchy_invalid_attempts_total` (counter, by
`reason`: `self_parent`/`cycle`/`invalid_period`/`max_depth_exceeded`) is
incremented inline by `organization-unit-hierarchy-service.ts` on EVERY
validator rejection, not sampled by the snapshot job.

## API

`basePath: /api/v1/organization-structure` — tenant-safe CRUD/list/search
for legal entities, unit types, units, locations, location-unit
relationships, assignments; a tree endpoint and an as-of query parameter
for the hierarchy; reparent requires `Idempotency-Key` and is audited
`critical`.

## Seed/import hooks

Import seed hooks are designed to go through the future `data_exchange`
contract (Issue #750/#752) — deliberately **not** a hard runtime
dependency of this module (issue #749 explicit requirement). No import
endpoint ships in this issue; the module's CRUD endpoints are themselves
sufficient for manual/scripted seeding until `data_exchange` exists.

## Out of scope (explicit)

Tenant provisioning/subscription management; chart of accounts,
inventory/warehouse stock, HR, payroll, tax, government-specific
organization rules; treating branch/legal entity as an RLS tenant
boundary; a hard runtime dependency on `data_exchange` (#750/#752).
