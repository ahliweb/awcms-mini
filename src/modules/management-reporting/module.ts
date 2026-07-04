import type { ModuleDescriptor } from "../_shared/module-contract";

export const managementReportingModule: ModuleDescriptor = {
  key: "management_reporting",
  name: "Management Reporting",
  version: "0.1.0",
  status: "experimental",
  description: "Dashboard dan laporan read-only berbasis view/materialized view per modul domain.",
  dependencies: ["tenant_admin","identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  }
};
