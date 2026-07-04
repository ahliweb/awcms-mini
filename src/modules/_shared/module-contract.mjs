const MODULE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MODULE_STATUS = new Set(["active", "experimental", "deprecated"]);
const MINI_SCOPE_MODEL = "single_tenant";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertStringArray(value, name) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
}

export function defineModule(descriptor) {
  validateModuleDescriptor(descriptor);
  return Object.freeze({
    ...descriptor,
    dependencies: Object.freeze([...descriptor.dependencies]),
    capabilities: Object.freeze([...(descriptor.capabilities ?? [])]),
    api: descriptor.api ? Object.freeze({ ...descriptor.api }) : undefined,
    events: descriptor.events
      ? Object.freeze({
          ...descriptor.events,
          publishes: Object.freeze([...(descriptor.events.publishes ?? [])]),
          subscribes: Object.freeze([...(descriptor.events.subscribes ?? [])]),
        })
      : undefined,
    security: Object.freeze({ ...descriptor.security }),
  });
}

export function validateModuleDescriptor(descriptor) {
  assertPlainObject(descriptor, "module descriptor");

  assertNonEmptyString(descriptor.key, "module key");
  if (!MODULE_KEY_PATTERN.test(descriptor.key)) {
    throw new TypeError("module key must be snake_case and start with a letter");
  }

  assertNonEmptyString(descriptor.name, "module name");
  assertNonEmptyString(descriptor.version, "module version");
  assertNonEmptyString(descriptor.description, "module description");

  if (!MODULE_STATUS.has(descriptor.status)) {
    throw new TypeError(`module status must be one of: ${[...MODULE_STATUS].join(", ")}`);
  }

  assertStringArray(descriptor.dependencies, "module dependencies");
  assertStringArray(descriptor.capabilities ?? [], "module capabilities");

  assertPlainObject(descriptor.security, "module security");
  if (descriptor.security.scopeModel !== MINI_SCOPE_MODEL) {
    throw new TypeError(`module security.scopeModel must be ${MINI_SCOPE_MODEL}`);
  }
  if (descriptor.security.authorization !== "rbac_abac") {
    throw new TypeError("module security.authorization must be rbac_abac");
  }
  if (descriptor.security.audit !== "required") {
    throw new TypeError("module security.audit must be required");
  }

  if (descriptor.api !== undefined) {
    assertPlainObject(descriptor.api, "module api");
    assertNonEmptyString(descriptor.api.basePath, "module api.basePath");
    if (!descriptor.api.basePath.startsWith("/api/v1")) {
      throw new TypeError("module api.basePath must be under /api/v1");
    }
  }

  if (descriptor.events !== undefined) {
    assertPlainObject(descriptor.events, "module events");
    assertStringArray(descriptor.events.publishes ?? [], "module events.publishes");
    assertStringArray(descriptor.events.subscribes ?? [], "module events.subscribes");
  }
}

export function listModuleDependencies(modules) {
  return modules.map((module) => ({
    key: module.key,
    dependencies: [...module.dependencies],
  }));
}

export function findUnknownModuleDependencies(modules) {
  const keys = new Set(modules.map((module) => module.key));
  const offenders = [];

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (!keys.has(dependency)) {
        offenders.push({ module: module.key, dependency });
      }
    }
  }

  return offenders;
}
