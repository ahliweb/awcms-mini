/**
 * Registry modul AWCMS-Mini (doc 10 & 11).
 * Aplikasi domain (mis. AWPOS) menambahkan modulnya sendiri di sini.
 */
import { assertValidModuleDescriptor, type ModuleDescriptor } from "./_shared/module-contract";
import { tenantAdminModule } from "./tenant-admin/module";
import { identityAccessModule } from "./identity-access/module";
import { profileIdentityModule } from "./profile-identity/module";
import { localizationUiModule } from "./localization-ui/module";
import { observabilityLoggingModule } from "./observability-logging/module";
import { databaseConnectivityModule } from "./database-connectivity/module";
import { workflowApprovalModule } from "./workflow-approval/module";
import { managementReportingModule } from "./management-reporting/module";
import { uiExperienceModule } from "./ui-experience/module";
import { productionSecurityReadinessModule } from "./production-security-readiness/module";
import { syncStorageModule } from "./sync-storage/module";

export const modules: ModuleDescriptor[] = [
  tenantAdminModule,
  profileIdentityModule,
  identityAccessModule,
  localizationUiModule,
  observabilityLoggingModule,
  databaseConnectivityModule,
  workflowApprovalModule,
  managementReportingModule,
  uiExperienceModule,
  productionSecurityReadinessModule,
  syncStorageModule
];

export function getModuleByKey(moduleKey: string): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

/**
 * Validasi registry: descriptor valid, key unik, dependency dikenal.
 * Dipanggil test arsitektur dan boot check.
 */
export function validateModuleRegistry(registry: ModuleDescriptor[] = modules): void {
  const keys = new Set<string>();
  for (const descriptor of registry) {
    assertValidModuleDescriptor(descriptor);
    if (keys.has(descriptor.key)) {
      throw new Error(`Module key duplikat: ${descriptor.key}`);
    }
    keys.add(descriptor.key);
  }
  for (const descriptor of registry) {
    for (const dependency of descriptor.dependencies) {
      if (!keys.has(dependency)) {
        throw new Error(
          `Module ${descriptor.key} bergantung pada module tidak dikenal: ${dependency}`
        );
      }
    }
  }
}
