import type { ModuleDescriptor } from "../_shared/module-contract";

export const localizationUiModule: ModuleDescriptor = {
  key: "localization_ui",
  name: "Localization UI",
  version: "0.1.0",
  status: "experimental",
  description: "i18n (id/en/ms/ar), kamus terjemahan, preferensi locale/theme per tenant.",
  dependencies: ["tenant_admin"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  }
};
