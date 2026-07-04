export type ModuleStatus = "active" | "experimental" | "deprecated";

export type ModuleDescriptor = {
  key: string;
  name: string;
  version: string;
  status: ModuleStatus;
  description: string;
  dependencies: string[];
  api?: {
    openApiPath?: string;
    basePath: string;
  };
  events?: {
    asyncApiPath?: string;
    publishes?: string[];
    subscribes?: string[];
  };
};

const moduleKeyPattern = /^[a-z][a-z0-9_]*$/;
const allowedStatuses = new Set<ModuleStatus>([
  "active",
  "experimental",
  "deprecated",
]);

export function defineModule(descriptor: ModuleDescriptor): ModuleDescriptor {
  validateModuleDescriptor(descriptor);
  return Object.freeze({
    ...descriptor,
    dependencies: Object.freeze([
      ...descriptor.dependencies,
    ]) as unknown as string[],
    api: descriptor.api ? Object.freeze({ ...descriptor.api }) : undefined,
    events: descriptor.events
      ? Object.freeze({
          ...descriptor.events,
          publishes: Object.freeze([
            ...(descriptor.events.publishes ?? []),
          ]) as unknown as string[],
          subscribes: Object.freeze([
            ...(descriptor.events.subscribes ?? []),
          ]) as unknown as string[],
        })
      : undefined,
  });
}

export function validateModuleDescriptor(descriptor: ModuleDescriptor): void {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("module descriptor must be an object");
  }

  if (!moduleKeyPattern.test(descriptor.key)) {
    throw new TypeError(
      "module key must be snake_case and start with a letter",
    );
  }

  if (!descriptor.name || !descriptor.version || !descriptor.description) {
    throw new TypeError("module name, version, and description are required");
  }

  if (!allowedStatuses.has(descriptor.status)) {
    throw new TypeError("module status is invalid");
  }

  if (!Array.isArray(descriptor.dependencies)) {
    throw new TypeError("module dependencies must be an array");
  }

  if (descriptor.api && !descriptor.api.basePath.startsWith("/api/v1")) {
    throw new TypeError("module api.basePath must be under /api/v1");
  }
}

export function findUnknownModuleDependencies(modules: ModuleDescriptor[]) {
  const keys = new Set(modules.map((module) => module.key));
  return modules.flatMap((module) =>
    module.dependencies
      .filter((dependency) => !keys.has(dependency))
      .map((dependency) => ({ module: module.key, dependency })),
  );
}
