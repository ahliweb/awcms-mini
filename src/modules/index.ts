import type { ModuleDescriptor } from "./_shared/module-contract";
import { tenantAdminModule } from "./tenant-admin/module";

export const modules: ModuleDescriptor[] = [tenantAdminModule];

export function getModuleByKey(
  moduleKey: string
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
