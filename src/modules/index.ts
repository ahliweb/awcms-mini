import { defineModule, type ModuleDescriptor } from "./_shared/module-contract";

export const modules: ModuleDescriptor[] = [
  defineModule({
    key: "tenant_admin",
    name: "Tenant Admin",
    version: "0.1.0",
    status: "active",
    description:
      "Tenant, office, physical location, and setup wizard foundation.",
    dependencies: ["observability_logging"],
    api: {
      openApiPath: "openapi/modules/tenant-admin.openapi.yaml",
      basePath: "/api/v1",
    },
    events: {
      asyncApiPath: "asyncapi/modules/tenant-events.asyncapi.yaml",
      publishes: ["tenant.created", "tenant.setup_locked"],
      subscribes: [],
    },
  }),
  defineModule({
    key: "identity_access",
    name: "Identity & Access",
    version: "0.1.0",
    status: "active",
    description:
      "Identity login, membership, RBAC, ABAC, sessions, and access decision logs.",
    dependencies: ["tenant_admin", "profile_identity", "observability_logging"],
    api: {
      openApiPath: "openapi/modules/identity-access.openapi.yaml",
      basePath: "/api/v1",
    },
    events: {
      asyncApiPath: "asyncapi/modules/access-events.asyncapi.yaml",
      publishes: [
        "identity.login_succeeded",
        "identity.login_failed",
        "access.assignment_changed",
      ],
      subscribes: ["tenant.created"],
    },
  }),
  defineModule({
    key: "profile_identity",
    name: "Profile Identity",
    version: "0.1.0",
    status: "active",
    description:
      "Central person/organization profiles, identifiers, links, and merge requests.",
    dependencies: ["tenant_admin", "observability_logging"],
    api: {
      openApiPath: "openapi/modules/profile-identity.openapi.yaml",
      basePath: "/api/v1",
    },
    events: {
      publishes: ["profile.created", "profile.merge_requested"],
      subscribes: [],
    },
  }),
  defineModule({
    key: "observability_logging",
    name: "Observability & Logging",
    version: "0.1.0",
    status: "active",
    description:
      "Structured logs, audit events, security events, request IDs, and readiness signals.",
    dependencies: [],
    api: {
      openApiPath: "openapi/modules/observability.openapi.yaml",
      basePath: "/api/v1",
    },
    events: {
      publishes: ["audit.event_recorded", "security.event_recorded"],
      subscribes: [],
    },
  }),
  defineModule({
    key: "database_connectivity",
    name: "Database Connectivity",
    version: "0.1.0",
    status: "active",
    description:
      "PostgreSQL migration, pool health, transaction, RLS context, and backpressure utilities.",
    dependencies: ["observability_logging"],
    api: {
      openApiPath: "openapi/modules/database-connectivity.openapi.yaml",
      basePath: "/api/v1",
    },
    events: {
      publishes: ["database.pool_saturated"],
      subscribes: [],
    },
  }),
];

export function listModules(): ModuleDescriptor[] {
  return [...modules];
}

export function getModuleByKey(
  moduleKey: string,
): ModuleDescriptor | undefined {
  return modules.find((module) => module.key === moduleKey);
}
