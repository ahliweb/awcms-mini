import type { ModuleDescriptor } from "./_shared/module-contract";
import { applicationModuleRegistry } from "./application-registry";
import { mergeModuleRegistries } from "./module-management/domain/module-composition";
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
import { profileIdentityModule } from "./profile-identity/module";
import { referenceDataModule } from "./reference-data/module";
import { reportingModule } from "./reporting/module";
import { serviceCatalogModule } from "./service-catalog/module";
import { socialPublishingModule } from "./social-publishing/module";
import { syncStorageModule } from "./sync-storage/module";
import { tenantAdminModule } from "./tenant-admin/module";
import { tenantDomainModule } from "./tenant-domain/module";
import { tenantEntitlementModule } from "./tenant-entitlement/module";
import { usageMeteringModule } from "./usage-metering/module";
import { visitorAnalyticsModule } from "./visitor-analytics/module";
import { workflowApprovalModule } from "./workflow-approval/module";

/**
 * The reviewed BASE registry — unchanged in shape/order/content by Issue
 * #740. Every module below is reviewed, in-repo code; nothing here is
 * conditional on a derived repository's own contribution.
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
  // Issue #875 (epic #868 SaaS control plane, Wave 1, ADR-0022) — the metering
  // foundation: a tenant-scoped control-plane module providing the
  // transaction-safe `usage_append` and read-only `usage_aggregate` contracts,
  // consuming #871's `effective_entitlement` for its fail-closed quota decision.
  // Also default-disabled (opt-in per tenant). Appended at the end, same
  // convention as the Wave-1 entries above.
  usageMeteringModule
];

/** Base-only registry, regardless of any application registry — Issue #740's composition API. */
export function listBaseModules(): readonly ModuleDescriptor[] {
  return baseModules;
}

/**
 * Final, effective registry — `baseModules` merged with an optional
 * build-time application registry (`./application-registry.ts`, Issue
 * #740). Merge only, never validated here: `index.ts` stays pure data,
 * exactly like before this issue (`listModules()` used to be `return
 * modules` with zero validation) — the composed registry's VALIDITY is a
 * separate, explicit check (`bun run modules:compose:check`,
 * `bun run modules:dag:check`, tests), never something module load itself
 * throws on. In this base repository, `applicationModuleRegistry` is
 * always `undefined`, so `modules` below is a byte-identical pass-through
 * of `baseModules` — the exact same effective registry as before this
 * change.
 */
export const modules: ModuleDescriptor[] = [
  ...mergeModuleRegistries(baseModules, applicationModuleRegistry)
];

export function getModuleByKey(
  moduleKey: string
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
