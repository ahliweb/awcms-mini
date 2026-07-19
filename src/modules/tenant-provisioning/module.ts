import { defineModule } from "../_shared/module-contract";

/**
 * `tenant_provisioning` — the THIRD SaaS control-plane module (Issue #872,
 * epic #868 Wave 1, ADR-0022). Admitted as an Official Optional Business
 * Foundation: in-repo reviewed code, opt-in per tenant, and
 * `defaultTenantState: "disabled"` (ADR-0022 §7) so a LAN/offline deployment
 * that never activates the control plane keeps it fully inert. Provisioning
 * commands are platform-operator only + default-deny.
 *
 * It orchestrates an IDEMPOTENT, RESUMABLE tenant-provisioning run — tenant
 * bootstrap, owner identity, default configuration, optional entitlement
 * assignment (via the #871 `effective_entitlement`/service ports), optional
 * module preset, optional subdomain, and mandatory readiness — with durable
 * checkpoints, bounded retries, lease/lock ownership, explicit compensation
 * classification (reversible/manual/forbidden), and NON-DESTRUCTIVE
 * reconciliation. It REUSES existing tenant/owner/office/config creation
 * (shared `tenant_admin` onboarding helpers) rather than duplicating it, runs
 * provider/async work OUTSIDE the source transaction (outbox/domain events),
 * and NEVER deletes tenant data as compensation. A failed/canceled run leaves
 * the tenant INACTIVE with a visible blocked/failed status + `readiness=blocked`
 * — never active without mandatory security controls.
 *
 * Every table is TENANT-SCOPED (`tenant_id` + `ENABLE` + `FORCE RLS`, predicate
 * ALWAYS AND ONLY `tenant_id` — no soft super-tenant, ADR-0022 §6). It PROVIDES
 * the read-only `provisioning_status` capability and CONSUMES the fail-closed
 * `effective_entitlement` contract (#871).
 */
export const tenantProvisioningModule = defineModule({
  key: "tenant_provisioning",
  name: "Tenant Provisioning",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — gated by
  // `tests/unit/module-governance-default-disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane tenant provisioning (Issue #872, epic #868 Wave 1, ADR-0022) — the THIRD control-plane module. Admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled) and tenant-scoped (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id, ADR-0022 §6 no soft super-tenant). Orchestrates an IDEMPOTENT, RESUMABLE provisioning run from a versioned plan/step registry: tenant record/bootstrap, owner identity, default configuration/locale, optional entitlement assignment (via the tenant_entitlement port), optional module preset, optional subdomain/domain, mandatory readiness, and derived-application contributed steps (via the provisioning_step capability port). Durable checkpoints, bounded retries, lease/lock ownership, idempotency-key replay, explicit compensation classification (reversible/manual/forbidden), and NON-DESTRUCTIVE desired-vs-actual reconciliation. REUSES existing tenant/owner/office/config creation (shared tenant_admin onboarding helpers) rather than duplicating it; runs provider/async work OUTSIDE the source transaction (outbox/domain events); NEVER deletes tenant data as compensation. A failed/canceled run leaves the tenant inactive with a visible blocked/failed status — never active without mandatory security controls. Provisioning commands are platform-operator only + default-deny; provider secrets are references only, never in step payloads/logs. PROVIDES the read-only provisioning_status capability; CONSUMES the fail-closed effective_entitlement contract (#871). LAN/offline safe: provisions with all online/provider steps absent or disabled.",
  // ADR-0022 §2 lifecycle dependencies (active first). `logging` for
  // `recordAuditEvent`; `domain_event_runtime` for `appendDomainEvent`.
  // `tenant_entitlement`/`service_catalog`/`tenant_domain`/`module_management`
  // are consumed via CAPABILITY/composition-root wiring (optional, LAN-safe),
  // NOT hard lifecycle dependencies. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "module_management",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The read-only run/readiness view a downstream module (#873) or operator
    // surface reads without importing this module.
    provides: ["provisioning_status"],
    // Reads the fail-closed effective entitlement at its composition root — never
    // a direct import (ADR-0022 §4, module-boundary).
    consumes: [
      {
        capability: "effective_entitlement",
        providedBy: "tenant_entitlement",
        optional: true
      }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.tenant-provisioning.requested",
      "awcms-mini.tenant-provisioning.completed",
      "awcms-mini.tenant-provisioning.failed",
      "awcms-mini.tenant-provisioning.reconciled"
    ]
  },
  jobs: [
    {
      command: "bun run tenant-provisioning:reconcile",
      purpose:
        "Run a non-destructive desired-vs-actual reconciliation pass over provisioned tenants (reports drift + safe operator actions; never auto-fixes).",
      recommendedSchedule: "daily",
      safeInOfflineLan: true,
      environmentNotes:
        "Reference command; documentation-only in the job registry (never executed from the UI). Reconciliation is DB-only and safe offline."
    }
  ],
  navigation: [
    {
      labelKey: "admin.layout.nav_tenant_provisioning",
      path: "/admin/tenant-provisioning",
      order: 132,
      requiredPermission: "tenant_provisioning.requests.read"
    }
  ],
  permissions: [
    {
      activityCode: "requests",
      action: "read",
      description:
        "Read tenant provisioning runs, steps, attempts, results, and timeline"
    },
    {
      activityCode: "requests",
      action: "create",
      description:
        "Request an idempotent tenant provisioning run (bootstraps the target tenant record)"
    },
    {
      activityCode: "requests",
      action: "retry",
      description:
        "Start, resume, or retry a tenant provisioning run from its durable checkpoint"
    },
    {
      activityCode: "requests",
      action: "cancel",
      description:
        "Cancel a tenant provisioning run when safe (records classified compensation; never deletes tenant data)"
    },
    {
      activityCode: "reconciliation",
      action: "check",
      description:
        "Run a non-destructive desired-vs-actual reconciliation of a provisioned tenant"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/tenant-provisioning"
  }
});
