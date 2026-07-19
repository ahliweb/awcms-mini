import { defineModule } from "../_shared/module-contract";

/**
 * `service_catalog` — the FIRST SaaS control-plane module (Issue #870, epic
 * #868, Wave 1, ADR-0022). Admitted as an Official Optional Business
 * Foundation module: in-repo reviewed code, opt-in per tenant, and
 * `defaultTenantState: "disabled"` (ADR-0022 §7) so a LAN/offline deployment
 * that never activates the control plane keeps it fully inert. Catalog
 * mutation is platform-operator only + default-deny (no role is granted its
 * permissions by the seed migration).
 *
 * All catalog data is GLOBAL control-plane data (no `tenant_id`); the tenant-
 * plane never queries it directly — it reads ONLY published offers through the
 * `service_catalog_read` capability (ADR-0022 §2/§4), which is backed by the
 * tenant-readable published projection. This is NOT an ERP item/product master
 * (ADR-0013 §3): it is a versioned commercial plan/offer catalog.
 */
export const serviceCatalogModule = defineModule({
  key: "service_catalog",
  name: "Service Catalog",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — the mechanism, read
  // by `resolveModuleEnabled`, the SSR permission gate, the nav registry, and
  // the tenant-module matrix; gated by `tests/unit/module-governance-default-
  // disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane service catalog (Issue #870, epic #868 Wave 1, ADR-0022) — the first control-plane module, admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled). Manages versioned commercial PLANS with an immutable-once-published OFFER lifecycle (draft -> validate -> publish -> retire), feature/whole-module entitlement grants, usage quotas (unit + reset policy), EXACT minor-unit prices (no floating point), and trial/availability/market/currency metadata. All catalog tables are GLOBAL control-plane data (no tenant_id, reviewed RLS-exempt, ADR-0022 §3): operator authoring/lifecycle tables hold the full working set (draft/published/retired + internal prices) and are platform-operator-only + default-deny; a separate tenant-readable PUBLISHED PROJECTION (awcms_mini_service_catalog_published_offers) carries only published versions + the public price subset and is the sole surface the `service_catalog_read` capability (consumed by tenant_entitlement, #871) reads. Published offer versions are IMMUTABLE (edit-in-place rejected by application + DB triggers; corrections = a new version). Feature/module/meter keys must resolve through a reviewed static registry (ModuleDescriptor.serviceCatalog contributions + the live module registry); unknown keys fail closed. publish/retire require Idempotency-Key + audit + emit versioned domain events. NOT an ERP item/product master (ADR-0013 §3).",
  // ADR-0022 §2: service_catalog depends on tenant_admin + identity_access +
  // domain_event_runtime; `logging` is added for `recordAuditEvent` (same as
  // reference_data). Acyclic; no base/core -> control-plane reverse edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The ONLY contract a tenant-plane/downstream module reads (published-only,
    // read-only). #871 consumes it.
    provides: ["service_catalog_read"]
  },
  // Neutral, non-authoritative EXAMPLE feature/meter keys proving the static-
  // registry contribution mechanism end-to-end (same "ship neutral examples of
  // your own mechanism" precedent reference_data set with currency/uom). A
  // derived application contributes its own keys through its own modules'
  // descriptors via `application-registry.ts` — never a base-registry edit.
  // Whole-module entitlement keys need no contribution (they ARE the live
  // module registry's keys).
  serviceCatalog: {
    contributesFeatureKeys: [
      "platform.api_access",
      "platform.priority_support",
      "platform.custom_domain"
    ],
    contributesMeterKeys: [
      "platform.api_calls",
      "platform.active_users",
      "platform.storage_bytes"
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.service-catalog.offer.published",
      "awcms-mini.service-catalog.offer.retired"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_service_catalog_plans",
      path: "/admin/service-catalog/plans",
      order: 130,
      requiredPermission: "service_catalog.plans.read"
    }
  ],
  permissions: [
    {
      activityCode: "plans",
      action: "read",
      description:
        "Read/list service catalog plans, versions, and published offers"
    },
    {
      activityCode: "plans",
      action: "create",
      description:
        "Create a draft service catalog plan and its first draft version"
    },
    {
      activityCode: "plans",
      action: "update",
      description:
        "Edit a draft plan/version (features, quotas, prices, availability) or draft a new version"
    },
    {
      activityCode: "offers",
      action: "publish",
      description:
        "Validate and publish a draft version into an immutable offer"
    },
    {
      activityCode: "offers",
      action: "retire",
      description: "Retire a published offer version"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/service-catalog"
  }
});
