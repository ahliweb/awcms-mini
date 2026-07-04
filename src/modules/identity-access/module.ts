import type { ModuleDescriptor } from "../_shared/module-contract";

export const identityAccessModule: ModuleDescriptor = {
  key: "identity_access",
  name: "Identity & Access",
  version: "0.1.0",
  status: "experimental",
  description: "Login identity, tenant user, RBAC role/permission, ABAC policy evaluator (default deny), dan decision log.",
  dependencies: ["tenant_admin","profile_identity"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "identity.login.succeeded",
        "identity.login.failed",
        "access.assignment.changed"
    ],
    subscribes: []
  }
};
