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
  },
  // Issue #592 (epic: full-online auth hardening #587-#593) — admin UI for
  // the #591 tenant auth policy/SSO provider admin CRUD API. Gated on
  // `sso_policy.read` (migration 037): a caller who can read the policy but
  // not the provider list still sees a meaningful (partial) page, same
  // navigation-visibility-is-not-authorization convention every other
  // module-declared nav entry follows (`domain/navigation-registry.ts`'s own
  // docblock) — the page itself re-checks both `sso_policy.*` and
  // `sso_providers.*` permissions independently before rendering each
  // section.
  navigation: [
    {
      labelKey: "admin.layout.nav_security",
      path: "/admin/security",
      order: 55,
      requiredPermission: "identity_access.sso_policy.read"
    }
  ]
});
