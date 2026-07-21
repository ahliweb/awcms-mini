import type { ModuleDescriptor } from "./_shared/module-contract";
import { blogContentModule } from "./blog-content/module";
import { dataExchangeModule } from "./data-exchange/module";
import { dataLifecycleModule } from "./data-lifecycle/module";
import { documentInfrastructureModule } from "./document-infrastructure/module";
import { domainEventRuntimeModule } from "./domain-event-runtime/module";
import { emailModule } from "./email/module";
import { formDraftsModule } from "./form-drafts/module";
import { identityAccessModule } from "./identity-access/module";
import { idnAdminRegionsModule } from "./idn-admin-regions/module";
import { integrationHubModule } from "./integration-hub/module";
import { loggingModule } from "./logging/module";
import { moduleManagementModule } from "./module-management/module";
import { newsPortalModule } from "./news-portal/module";
import { organizationStructureModule } from "./organization-structure/module";
import { paymentGatewayModule } from "./payment-gateway/module";
import { profileIdentityModule } from "./profile-identity/module";
import { referenceDataModule } from "./reference-data/module";
import { reportingModule } from "./reporting/module";
import { serviceCatalogModule } from "./service-catalog/module";
import { socialPublishingModule } from "./social-publishing/module";
import { subscriptionBillingModule } from "./subscription-billing/module";
import { syncStorageModule } from "./sync-storage/module";
import { tenantAdminModule } from "./tenant-admin/module";
import { tenantDomainModule } from "./tenant-domain/module";
import { tenantEntitlementModule } from "./tenant-entitlement/module";
import { tenantLifecycleModule } from "./tenant-lifecycle/module";
import { tenantProvisioningModule } from "./tenant-provisioning/module";
import { usageMeteringModule } from "./usage-metering/module";
import { visitorAnalyticsModule } from "./visitor-analytics/module";
import { workflowApprovalModule } from "./workflow-approval/module";

/**
 * The reviewed BASE registry. Every module below is reviewed, in-repo code.
 */
const baseModules: ModuleDescriptor[] = [
  tenantAdminModule,
  profileIdentityModule,
  identityAccessModule,
  syncStorageModule,
  reportingModule,
  loggingModule,
  workflowApprovalModule,
  formDraftsModule,
  emailModule,
  moduleManagementModule,
  blogContentModule,
  tenantDomainModule,
  visitorAnalyticsModule,
  newsPortalModule,
  idnAdminRegionsModule,
  socialPublishingModule,
  // Issue #745/#742 (epic #738 platform-evolution Wave 1) — both appended
  // at the end (rather than reordered near their dependencies) so parallel
  // Wave-1 PRs registering their own new module could each add an entry
  // independently with a minimal, easily-resolved merge conflict (keep
  // BOTH new entries, never pick one side — resolved exactly that way).
  dataLifecycleModule,
  domainEventRuntimeModule,
  // Issue #749 (epic #738 platform-evolution Wave 2, ADR-0016) — brand new
  // top-level module (unlike its Wave-2 siblings #746/#747/#748, which
  // extended existing modules) — appended at the end, same convention as
  // the Wave-1 entries immediately above.
  organizationStructureModule,
  // Issue #751 (epic #738 platform-evolution Wave 3, ADR-0017), Issue #752
  // (Wave 3, ADR-0018, data_exchange), Issue #754 (Wave 3, ADR-0019,
  // integration_hub), and Issue #750 (Wave 3, ADR-0021 — renumbered from
  // ADR-0018 to resolve a cross-PR ADR numbering collision, see ADR
  // README index — reference_data) — all brand new top-level modules,
  // appended at the end. Several Wave-3 issues register their OWN new
  // module entries in parallel here — on merge conflict, keep BOTH/ALL
  // sides' new entries, never pick one (established recipe, see
  // #745/#742's own comment above).
  documentInfrastructureModule,
  dataExchangeModule,
  integrationHubModule,
  referenceDataModule,
  // Issue #870 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the first
  // control-plane module, admitted Official Optional + default-disabled.
  // Appended at the end, same convention as the Wave-1/Wave-3 entries above;
  // #871-#877 append their own control-plane modules here as they land.
  serviceCatalogModule,
  // Issue #871 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the second
  // control-plane module and the epic's HEART: the first tenant-scoped one,
  // providing the fail-closed `effective_entitlement` contract. Also
  // default-disabled (opt-in per tenant).
  tenantEntitlementModule,
  // Issue #872 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the third
  // control-plane module: idempotent/resumable tenant provisioning orchestration
  // with compensation, reconciliation, and readiness. Consumes the
  // effective_entitlement contract; provides provisioning_status. Also
  // default-disabled (opt-in per tenant).
  tenantProvisioningModule,
  // Issue #875 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the metering
  // foundation: a tenant-scoped control-plane module providing the
  // transaction-safe `usage_append` and read-only `usage_aggregate` contracts,
  // consuming #871's `effective_entitlement` for its fail-closed quota decision.
  // Also default-disabled (opt-in per tenant). Appended at the end, same
  // convention as the Wave-1 entries above.
  usageMeteringModule,
  // Issue #873 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the fourth
  // control-plane module: precise SaaS lifecycle state machine with versioned
  // transitions, server-derived fail-closed restrictions enforced across API/
  // SSR/public/worker, idempotent scheduled transitions, downgrade (data-
  // preserving), and reconciled restore. Provides tenant_restrictions +
  // lifecycle_transition; consumes effective_entitlement (#871) and
  // provisioning_status (#872). Also default-disabled (opt-in per tenant).
  tenantLifecycleModule,
  // Issue #876 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the fifth
  // control-plane module: commercial SaaS subscription billing STATE
  // (subscriptions bound to immutable published offers, billing periods,
  // draft/issued/immutable invoices + lines, credit notes, payment allocation
  // references, dunning, scheduled upgrade/downgrade/cancel). Money is EXACT
  // minor units; issued invoices immutable; invoice generation idempotent per
  // (subscription, period, offer version). Provides billing_document_state
  // (consumed by payment_gateway #877); consumes service_catalog_read (#870),
  // usage_aggregate (#875), and lifecycle_transition (#873). NOT a general
  // ledger / AR-AP / tax engine (ADR-0022 §11). Also default-disabled.
  subscriptionBillingModule,
  // Issue #877 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the sixth and
  // LAST control-plane module: provider-neutral payment gateway (hosted checkout/
  // session, signed fail-closed webhook inbox with durable per-event-id
  // anti-replay, normalized events, refunds, retry/DLQ, provider health + circuit
  // breaker, reconciliation). The provider call always runs OUTSIDE any DB
  // transaction (ADR-0006); payment status is never trusted from a browser
  // redirect — only a verified signed webhook or reconciliation. Provider secrets
  // live in process.env only; adapters are optional config (fake/sandbox in base).
  // Consumes billing_document_state (#876); provides payment_outcome. NOT a GL /
  // AR-AP / merchant settlement / tax engine (ADR-0022 §11). Also default-disabled.
  paymentGatewayModule
];

/**
 * Base registry accessor. Retained as a distinct name from `listModules()`
 * for the composition/reporting/SoD gates that validate the reviewed base
 * registry explicitly.
 */
export function listBaseModules(): readonly ModuleDescriptor[] {
  return baseModules;
}

/**
 * The effective module registry. `index.ts` stays pure data — module load
 * never validates or throws; the registry's VALIDITY is a separate,
 * explicit check (`bun run modules:compose:check`,
 * `bun run modules:dag:check`, tests). Each entry keeps its own object
 * identity from `baseModules`. (ADR-0024 removed the derived-application
 * composition seam; the effective registry is now the base registry.)
 */
export const modules: ModuleDescriptor[] = [...baseModules];

export function getModuleByKey(
  moduleKey: string
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
