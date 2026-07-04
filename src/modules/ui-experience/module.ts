import type { ModuleDescriptor } from "../_shared/module-contract";

export const uiExperienceModule: ModuleDescriptor = {
  key: "ui_experience",
  name: "UI Experience",
  version: "0.1.0",
  status: "experimental",
  description: "Admin shell, navigation registry per modul, design token (doc 14), theme light/dark/system.",
  dependencies: ["localization_ui","identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  }
};
