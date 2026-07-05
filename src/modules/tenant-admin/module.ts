import { defineModule } from "../_shared/module-contract";

export const tenantAdminModule = defineModule({
  key: "tenant_admin",
  name: "Tenant Admin",
  version: "0.1.0",
  status: "experimental",
  description:
    "Tenant root entity, office hierarchy, physical locations, and tenant settings.",
  dependencies: []
});
