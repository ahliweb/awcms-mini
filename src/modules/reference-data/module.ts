import { defineModule } from "../_shared/module-contract";
import { REFERENCE_DATA_SEED_CONTRIBUTIONS } from "./application/seed-contributions";

export const referenceDataModule = defineModule({
  key: "reference_data",
  name: "Reference Data",
  version: "0.1.0",
  status: "active",
  type: "domain",
  description:
    "Optional, provider-neutral reference-data foundation (Issue #750, epic `platform-evolution` #738 Wave 3, ADR-0021). Admitted as an Official Optional Business Foundation module — opt-in per tenant, generic across every derived application, never an ERP/domain-specific implementation. Adds GLOBAL (no tenant_id, reviewed RLS-exempt, ADR-0021 §8) effective-dated value sets (`awcms_mini_reference_value_sets`) and codes (`awcms_mini_reference_codes` + `awcms_mini_reference_code_translations`) with provenance, deprecation/supersession, and a validated import pipeline (`awcms_mini_reference_imports`, dry-run/diff non-mutating, commit re-validates INSIDE the same transaction and rejects destructive replacement of codes already referenced by tenant data), plus a TENANT-SCOPED (RLS FORCE, predicate always and only tenant_id) override/extension layer (`awcms_mini_reference_tenant_codes` + `awcms_mini_reference_tenant_code_translations`) that NEVER mutates the global baseline. Provides `ReferenceDataPort` (`_shared/ports/reference-data-port.ts`) for resolving codes/snapshots, and a static module-contribution mechanism (`ModuleDescriptor.referenceData.contributesValueSets`) letting other modules register their own reference catalogs without direct table imports (`application/contribution-sync.ts`, `bun run reference-data:contributions:sync`). Ships currency/unit-of-measure/fiscal-calendar as neutral, non-authoritative examples of its own mechanism (`application/seed-contributions.ts`). `idn_admin_regions` remains module-owned and is NOT duplicated or migrated into this module's generic tables (ADR-0021 §4).",
  dependencies: ["tenant_admin", "identity_access", "domain_event_runtime"],
  capabilities: {
    provides: ["reference_data_resolution"]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.reference-data.value-set.created",
      "awcms-mini.reference-data.value-set.updated",
      "awcms-mini.reference-data.value-set.deprecated",
      "awcms-mini.reference-data.code.created",
      "awcms-mini.reference-data.code.updated",
      "awcms-mini.reference-data.code.deprecated",
      "awcms-mini.reference-data.import.committed",
      "awcms-mini.reference-data.import.rolled-back",
      "awcms-mini.reference-data.tenant-code.created",
      "awcms-mini.reference-data.tenant-code.deprecated"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_reference_data_value_sets",
      path: "/admin/reference-data/value-sets",
      order: 110,
      requiredPermission: "reference_data.value_sets.read"
    },
    {
      labelKey: "admin.layout.nav_reference_data_codes",
      path: "/admin/reference-data/codes",
      order: 111,
      requiredPermission: "reference_data.codes.read"
    },
    {
      labelKey: "admin.layout.nav_reference_data_tenant_codes",
      path: "/admin/reference-data/tenant-codes",
      order: 112,
      requiredPermission: "reference_data.tenant_codes.read"
    }
  ],
  permissions: [
    {
      activityCode: "value_sets",
      action: "read",
      description: "Read/list/search reference value sets"
    },
    {
      activityCode: "value_sets",
      action: "create",
      description: "Create a platform-curated reference value set"
    },
    {
      activityCode: "value_sets",
      action: "update",
      description: "Update a reference value set's metadata"
    },
    {
      activityCode: "value_sets",
      action: "delete",
      description: "Deprecate (soft-delete) a reference value set"
    },
    {
      activityCode: "value_sets",
      action: "restore",
      description: "Restore a previously deprecated reference value set"
    },
    {
      activityCode: "codes",
      action: "read",
      description: "Read/list/search reference codes for a value set"
    },
    {
      activityCode: "codes",
      action: "create",
      description: "Create a reference code manually"
    },
    {
      activityCode: "codes",
      action: "update",
      description: "Update a reference code's mutable attributes"
    },
    {
      activityCode: "codes",
      action: "delete",
      description: "Deprecate (soft-delete) a reference code"
    },
    {
      activityCode: "codes",
      action: "restore",
      description: "Restore a previously deprecated reference code"
    },
    {
      activityCode: "imports",
      action: "read",
      description: "Read/list reference data import batches"
    },
    {
      activityCode: "imports",
      action: "create",
      description: "Submit a non-mutating dry-run import for a value set"
    },
    {
      activityCode: "imports",
      action: "commit",
      description: "Commit a validated reference data import batch"
    },
    {
      activityCode: "imports",
      action: "rollback",
      description: "Roll back a committed reference data import batch"
    },
    {
      activityCode: "tenant_codes",
      action: "read",
      description:
        "Read/list the caller's tenant reference code overrides/extensions"
    },
    {
      activityCode: "tenant_codes",
      action: "create",
      description: "Create a tenant reference code override or extension"
    },
    {
      activityCode: "tenant_codes",
      action: "update",
      description: "Update a tenant reference code override/extension"
    },
    {
      activityCode: "tenant_codes",
      action: "delete",
      description:
        "Deprecate (soft-delete) a tenant reference code override/extension"
    },
    {
      activityCode: "tenant_codes",
      action: "restore",
      description:
        "Restore a previously deprecated tenant reference code override/extension"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/reference-data"
  },
  referenceData: {
    contributesValueSets: REFERENCE_DATA_SEED_CONTRIBUTIONS
  }
});
