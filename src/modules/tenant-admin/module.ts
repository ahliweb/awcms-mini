import type { ModuleDescriptor } from "../_shared/module-contract";

export const tenantAdminModule: ModuleDescriptor = {
  key: "tenant_admin",
  name: "Tenant Admin",
  version: "0.1.0",
  status: "experimental",
  description: "Tenant, office/unit kerja, tenant settings, dan setup wizard aplikasi.",
  dependencies: [],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "tenant.created",
        "tenant.office.updated"
    ],
    subscribes: []
  }
};
