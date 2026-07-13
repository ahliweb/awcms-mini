import type { ModuleDescriptor } from "./_shared/module-contract";
import { blogContentModule } from "./blog-content/module";
import { dataLifecycleModule } from "./data-lifecycle/module";
import { emailModule } from "./email/module";
import { formDraftsModule } from "./form-drafts/module";
import { identityAccessModule } from "./identity-access/module";
import { idnAdminRegionsModule } from "./idn-admin-regions/module";
import { loggingModule } from "./logging/module";
import { moduleManagementModule } from "./module-management/module";
import { newsPortalModule } from "./news-portal/module";
import { profileIdentityModule } from "./profile-identity/module";
import { reportingModule } from "./reporting/module";
import { socialPublishingModule } from "./social-publishing/module";
import { syncStorageModule } from "./sync-storage/module";
import { tenantAdminModule } from "./tenant-admin/module";
import { tenantDomainModule } from "./tenant-domain/module";
import { visitorAnalyticsModule } from "./visitor-analytics/module";
import { workflowApprovalModule } from "./workflow-approval/module";

export const modules: ModuleDescriptor[] = [
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
  // Issue #745 (epic #738 platform-evolution Wave 1) — appended at the end
  // (rather than reordered near its dependencies) so a sibling Wave-1 PR
  // registering its own new module (e.g. domain_event_runtime, #742) can
  // add its own entry here independently with a minimal, easily-resolved
  // merge conflict (keep BOTH new entries, never pick one side).
  dataLifecycleModule
];

export function getModuleByKey(
  moduleKey: string
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
