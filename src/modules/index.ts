import type { ModuleDescriptor } from "./_shared/module-contract";

export const modules: ModuleDescriptor[] = [];

export function getModuleByKey(
  moduleKey: string,
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}

export function listModules(): readonly ModuleDescriptor[] {
  return modules;
}
