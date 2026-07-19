import { defineModule } from "../_shared/module-contract";

/**
 * `tenant_entitlement` — the SECOND SaaS control-plane module and the HEART of
 * epic #868 (Issue #871, Wave 1, ADR-0022). Admitted as an Official Optional
 * Business Foundation module: in-repo reviewed code, opt-in per tenant, and
 * `defaultTenantState: "disabled"` (ADR-0022 §7) so a LAN/offline deployment
 * that never activates the control plane keeps it fully inert. It is the FIRST
 * TENANT-SCOPED control-plane module (every table is `tenant_id` + `ENABLE` +
 * `FORCE RLS`, predicate ALWAYS AND ONLY `tenant_id` — no soft super-tenant,
 * ADR-0022 §6). Entitlement management is platform-operator only + default-deny
 * (no role is granted its permissions by the seed migration).
 *
 * It derives a tenant's EFFECTIVE feature/module/quota access from published
 * `service_catalog` offers (read through the `service_catalog_read` capability
 * port, never a direct import) plus operator overrides, and PROVIDES the single
 * `effective_entitlement` contract — the ONLY thing the tenant-plane and the
 * downstream control-plane modules (#872/#873/#875/#876) read to gate
 * commercial access. That contract is FAIL-CLOSED (unknown/absent/indeterminate
 * /disabled = DENY, ADR-0022 §4 High-2) and lives on a DIFFERENT axis from
 * RBAC/ABAC/RLS — a positive entitlement can never grant an authorization the
 * actor lacks, and entitlement loss changes STATE + gates, it never deletes
 * tenant data.
 */
export const tenantEntitlementModule = defineModule({
  key: "tenant_entitlement",
  name: "Tenant Entitlement",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — the mechanism read by
  // `resolveModuleEnabled`, the SSR permission gate, the nav registry, and the
  // tenant-module matrix; gated by `tests/unit/module-governance-default-
  // disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane tenant entitlement (Issue #871, epic #868 Wave 1, ADR-0022) — the SECOND control-plane module and the epic's HEART. Admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled) and the FIRST tenant-scoped control-plane module (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id, ADR-0022 §6 no soft super-tenant). Resolves a tenant's EFFECTIVE feature/module/quota access DETERMINISTICALLY and EXPLAINABLY from: published service_catalog offer versions (read via the service_catalog_read capability port), trial/grace effective-dating, platform-operator overrides (grant/deny, reason-bound, optionally time-bound, revocable without restart), suspension/lifecycle restriction, and module-dependency safe-downgrade. Exposes ONE read-only capability port, effective_entitlement, that is FAIL-CLOSED (unknown/absent/indeterminate/disabled = DENY, ADR-0022 §4 High-2) and gates commercial access on a DIFFERENT axis from RBAC/ABAC/RLS — a positive entitlement NEVER grants a permission the actor lacks. Resolution is BOUNDED (bulk query + in-memory, no per-request N+1 catalog query). Assignments/overrides are immutable-once-created except one-way status/revocation transitions; evaluation snapshots are append-only (reproducibility + deterministic cache invalidation via a tenant-facing snapshot hash). assign/override/revoke require Idempotency-Key + audit + emit versioned domain events. Module entitlement is DISTINCT from module enabled-state (awcms_mini_tenant_modules) but coordinated; entitlement loss changes state + gates, NEVER deletes tenant data.",
  // ADR-0022 §2 lifecycle dependencies (active first). `logging` is added for
  // `recordAuditEvent` (same as service_catalog). service_catalog is consumed
  // via CAPABILITY (published offers are GLOBAL operator data, readable
  // regardless of the tenant's service_catalog enabled-state), NOT a hard
  // lifecycle dependency — the same capability-without-dependency shape
  // blog_content/news_portal use. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "module_management",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The ONE contract a tenant-plane / downstream module reads to gate
    // commercial access (read-only, fail-closed). #872/#873/#875/#876 consume it.
    provides: ["effective_entitlement"],
    // Reads published offers through service_catalog's read-only port at its own
    // composition root — never a direct import (ADR-0022 §4, module-boundary).
    consumes: [
      { capability: "service_catalog_read", providedBy: "service_catalog" }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.tenant-entitlement.assignment.changed",
      "awcms-mini.tenant-entitlement.override.changed"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_tenant_entitlement",
      path: "/admin/tenant-entitlement",
      order: 131,
      requiredPermission: "tenant_entitlement.entitlement.read"
    }
  ],
  permissions: [
    {
      activityCode: "entitlement",
      action: "read",
      description:
        "Read a tenant's resolved effective entitlement (features/modules/quotas) with source explanation"
    },
    {
      activityCode: "assignments",
      action: "read",
      description:
        "List a tenant's entitlement assignments (subscriptions to published offers)"
    },
    {
      activityCode: "assignments",
      action: "assign",
      description:
        "Assign (subscribe) a tenant to a published service catalog offer version"
    },
    {
      activityCode: "assignments",
      action: "update",
      description:
        "Suspend or resume a tenant entitlement assignment (lifecycle restriction; data preserved)"
    },
    {
      activityCode: "assignments",
      action: "revoke",
      description:
        "Cancel a tenant entitlement assignment (entitlement loss; tenant data is never deleted)"
    },
    {
      activityCode: "overrides",
      action: "read",
      description:
        "List a tenant's entitlement overrides (operator grants/denies)"
    },
    {
      activityCode: "overrides",
      action: "override",
      description:
        "Create a platform-operator entitlement override (grant/deny a feature, module, or quota; reason required, optionally time-bound)"
    },
    {
      activityCode: "overrides",
      action: "revoke",
      description:
        "Revoke a tenant entitlement override (stops applying immediately, without restart)"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/tenant-entitlement"
  }
});
