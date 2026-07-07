import type { ModuleDescriptor } from "./_shared/module-contract";
import { blogContentModule } from "./blog-content/module";
import { emailModule } from "./email/module";
import { formDraftsModule } from "./form-drafts/module";
import { identityAccessModule } from "./identity-access/module";
import { loggingModule } from "./logging/module";
import { moduleManagementModule } from "./module-management/module";
import { profileIdentityModule } from "./profile-identity/module";
import { reportingModule } from "./reporting/module";
import { syncStorageModule } from "./sync-storage/module";
import { tenantAdminModule } from "./tenant-admin/module";
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
  blogContentModule
];

export function getModuleByKey(
  moduleKey: string
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
