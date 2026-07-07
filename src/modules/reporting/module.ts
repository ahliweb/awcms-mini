import { defineModule } from "../_shared/module-contract";

export const reportingModule = defineModule({
  key: "reporting",
  name: "Management Reporting",
  version: "1.1.0",
  status: "active",
  description:
    "Generic management reporting views (tenant activity, access/audit summary, sync health, module usage, email queue health — Issue #499) built as live read-aggregations over tenant_admin, identity_access, sync_storage, and email tables. Derived applications add their own domain-specific reporting views on top of this base.",
  dependencies: ["tenant_admin", "identity_access", "sync_storage", "email"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/reports"
  }
});
