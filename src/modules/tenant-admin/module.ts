import { defineModule } from "../_shared/module-contract";

export const tenantAdminModule = defineModule({
  key: "tenant_admin",
  name: "Tenant Admin",
  version: "1.0.0",
  status: "active",
  description:
    "Tenant root entity, office hierarchy, physical locations, tenant settings, and the one-time setup wizard that bootstraps the first tenant, owner, office, role, and access assignment.",
  dependencies: ["profile_identity", "identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/setup"
  }
});
