import { defineModule } from "../_shared/module-contract";

export const identityAccessModule = defineModule({
  key: "identity_access",
  name: "Identity & Access",
  version: "1.0.0",
  status: "active",
  description:
    "Login identity, password hashing, tenant user membership, session-based authentication, and RBAC/ABAC access control (roles, permissions, assignments, decision log).",
  dependencies: ["tenant_admin", "profile_identity"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  }
});
