import { defineModule } from "../_shared/module-contract";

export const identityAccessModule = defineModule({
  key: "identity_access",
  name: "Identity & Access",
  version: "0.1.0",
  status: "experimental",
  description:
    "Login identity, password hashing, tenant user membership, and session-based authentication.",
  dependencies: ["tenant_admin", "profile_identity"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/auth"
  }
});
