import type { ModuleDescriptor } from "./_shared/module-contract";
import { identityAccessModule } from "./identity-access/module";
import { profileIdentityModule } from "./profile-identity/module";
import { tenantAdminModule } from "./tenant-admin/module";

export const modules: ModuleDescriptor[] = [
  tenantAdminModule,
  profileIdentityModule,
  identityAccessModule
];

export function getModuleByKey(
  moduleKey: string
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
