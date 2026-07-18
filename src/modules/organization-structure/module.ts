import { defineModule } from "../_shared/module-contract";

export const organizationStructureModule = defineModule({
  key: "organization_structure",
  name: "Organization Structure",
  version: "0.1.0",
  status: "active",
  description:
    'Optional, tenant-scoped organization-structure foundation (Issue #749, epic `platform-evolution` #738 Wave 2, ADR-0016 admission decision, ADR-0013 §2/§4 tenant vs legal entity vs organization unit vocabulary). Admitted as an Official Optional Business Foundation module — opt-in per tenant, generic across every derived application, never an ERP implementation. Adds tenant-scoped legal entities (`awcms_mini_legal_entities`, generic opaque registration identifier pair, never government-specific fields), tenant-configurable organization-unit types (`awcms_mini_organization_unit_types`), effective-dated organization units (`awcms_mini_organization_units`, optionally linked to a legal entity — never required — and optionally typed), a versioned/effective-dated (SCD Type 2 style) parent-child hierarchy (`awcms_mini_organization_unit_hierarchies`, reparenting NEVER mutates a parent_id column in place — it closes the current period and opens a new one, no-cycle/self-parent/overlap validated transactionally with a tenant-wide `pg_advisory_xact_lock`), operational locations (`awcms_mini_operational_locations`, optional lat/lng validated to [-90,90]/[-180,180]), an explicit location-to-unit many-to-many relationship (`awcms_mini_location_unit_relationships`), and effective-dated party/unit assignments (`awcms_mini_organization_unit_assignments`, referencing `identity_access`\'s existing `awcms_mini_tenant_users` — never a duplicate person/party registry, ADR-0013 §4). Provides a REAL implementation of `BusinessScopeHierarchyPort` (`_shared/ports/business-scope-hierarchy-port.ts`) for `scopeType` "legal_entity"/"organization_unit" (`application/organization-structure-hierarchy-port-adapter.ts`) — `identity_access` has no lifecycle or capability dependency on this module in either direction (Core never depends on Optional, ADR-0013 §1); a composition root chooses which adapter to inject. Tenant and legal entity/organization unit remain distinct concepts everywhere (ADR-0013 §2) — every table\'s RLS predicate is always and only `tenant_id`.',
  // `logging` declared for Issue #845 (epic #818): every directory/service
  // here calls `logging`'s `recordAuditEvent`. Acyclic.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "domain_event_runtime",
    "logging"
  ],
  type: "domain",
  // This module PROVIDES an implementation of `BusinessScopeHierarchyPort`
  // for identity-access's business-scope assignment/SoD machinery to
  // optionally consume — it does NOT declare any `consumes` entry back
  // toward `identity_access` for this (the port lives in `_shared`, not
  // owned by either module), and `identity_access/module.ts` does NOT
  // declare a capability/lifecycle dependency on `organization_structure`
  // in the other direction either (Core never depends on Optional,
  // ADR-0013 §1). See `application/organization-structure-hierarchy-port-
  // adapter.ts`'s own header for how a composition root chooses between
  // identity-access's flat default adapter and this module's real one.
  capabilities: {
    provides: ["organization_hierarchy_resolution"]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.organization-structure.legal-entity.created",
      "awcms-mini.organization-structure.legal-entity.updated",
      "awcms-mini.organization-structure.legal-entity.deactivated",
      "awcms-mini.organization-structure.unit.created",
      "awcms-mini.organization-structure.unit.updated",
      "awcms-mini.organization-structure.unit.deactivated",
      "awcms-mini.organization-structure.hierarchy.changed",
      "awcms-mini.organization-structure.assignment.created",
      "awcms-mini.organization-structure.assignment.ended"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_organization_structure_legal_entities",
      path: "/admin/organization-structure/legal-entities",
      order: 100,
      requiredPermission: "organization_structure.legal_entities.read"
    },
    {
      labelKey: "admin.layout.nav_organization_structure_unit_types",
      path: "/admin/organization-structure/unit-types",
      order: 101,
      requiredPermission: "organization_structure.unit_types.read"
    },
    {
      labelKey: "admin.layout.nav_organization_structure_units",
      path: "/admin/organization-structure/units",
      order: 102,
      requiredPermission: "organization_structure.units.read"
    },
    {
      labelKey: "admin.layout.nav_organization_structure_hierarchy",
      path: "/admin/organization-structure/hierarchy",
      order: 103,
      requiredPermission: "organization_structure.hierarchy.read"
    },
    {
      labelKey: "admin.layout.nav_organization_structure_locations",
      path: "/admin/organization-structure/locations",
      order: 104,
      requiredPermission: "organization_structure.locations.read"
    },
    {
      labelKey: "admin.layout.nav_organization_structure_assignments",
      path: "/admin/organization-structure/assignments",
      order: 105,
      requiredPermission: "organization_structure.assignments.read"
    }
  ],
  permissions: [
    {
      activityCode: "legal_entities",
      action: "read",
      description: "Read legal entities for the caller's tenant"
    },
    {
      activityCode: "legal_entities",
      action: "create",
      description: "Create a legal entity"
    },
    {
      activityCode: "legal_entities",
      action: "update",
      description: "Update a legal entity's neutral metadata"
    },
    {
      activityCode: "legal_entities",
      action: "delete",
      description: "Deactivate (soft-delete) a legal entity"
    },
    {
      activityCode: "legal_entities",
      action: "restore",
      description: "Restore a previously deactivated legal entity"
    },
    {
      activityCode: "unit_types",
      action: "read",
      description: "Read organization-unit types"
    },
    {
      activityCode: "unit_types",
      action: "create",
      description: "Create an organization-unit type"
    },
    {
      activityCode: "unit_types",
      action: "update",
      description: "Update an organization-unit type"
    },
    {
      activityCode: "unit_types",
      action: "delete",
      description: "Soft-delete an organization-unit type"
    },
    {
      activityCode: "unit_types",
      action: "restore",
      description: "Restore a soft-deleted organization-unit type"
    },
    {
      activityCode: "units",
      action: "read",
      description: "Read/list/search organization units"
    },
    {
      activityCode: "units",
      action: "create",
      description: "Create an organization unit"
    },
    {
      activityCode: "units",
      action: "update",
      description: "Update an organization unit"
    },
    {
      activityCode: "units",
      action: "delete",
      description: "Soft-delete an organization unit"
    },
    {
      activityCode: "units",
      action: "restore",
      description: "Restore a soft-deleted organization unit"
    },
    {
      activityCode: "hierarchy",
      action: "read",
      description:
        "Read organization-unit hierarchy edges, tree, and as-of history"
    },
    {
      activityCode: "hierarchy",
      action: "assign",
      description: "Create or reparent an organization-unit hierarchy edge"
    },
    {
      activityCode: "locations",
      action: "read",
      description: "Read operational locations"
    },
    {
      activityCode: "locations",
      action: "create",
      description: "Create an operational location"
    },
    {
      activityCode: "locations",
      action: "update",
      description: "Update an operational location"
    },
    {
      activityCode: "locations",
      action: "delete",
      description: "Soft-delete an operational location"
    },
    {
      activityCode: "locations",
      action: "restore",
      description: "Restore a soft-deleted operational location"
    },
    {
      activityCode: "location_unit_relationships",
      action: "read",
      description: "Read location-to-unit relationships"
    },
    {
      activityCode: "location_unit_relationships",
      action: "create",
      description: "Create a location-to-unit relationship"
    },
    {
      activityCode: "location_unit_relationships",
      action: "revoke",
      description: "End a location-to-unit relationship"
    },
    {
      activityCode: "assignments",
      action: "read",
      description: "Read organization-unit assignments"
    },
    {
      activityCode: "assignments",
      action: "create",
      description: "Create an organization-unit assignment"
    },
    {
      activityCode: "assignments",
      action: "revoke",
      description: "End an organization-unit assignment"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/organization-structure"
  },
  jobs: [
    {
      command: "bun run organization-structure:metrics-snapshot",
      purpose:
        "Read-only per-tenant metrics snapshot (active units, hierarchy max depth, expiring-soon assignments) recorded as gauges via the shared metrics port (src/lib/observability/metrics-port.ts). Never mutates data.",
      recommendedSchedule: "Every 15-60 minutes via cron/systemd timer.",
      environmentNotes:
        "Pure database reads plus in-process gauge sets — no external provider, no write to any table. Safe in every deployment profile.",
      safeInOfflineLan: true
    }
  ]
});
