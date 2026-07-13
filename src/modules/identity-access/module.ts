import { defineModule } from "../_shared/module-contract";

export const identityAccessModule = defineModule({
  key: "identity_access",
  name: "Identity & Access",
  version: "1.0.0",
  status: "active",
  description:
    'Login identity, password hashing, tenant user membership, session-based authentication, and RBAC/ABAC access control (roles, permissions, assignments, decision log). `dependencies: ["tenant_admin", "profile_identity"]` was already correct (Issue #680, epic #679) — the registry-wide 3-cycle this issue fixed came entirely from `tenant_admin` ALSO listing `profile_identity`/`identity_access` as its own dependencies (removed there), not from this module\'s own array.',
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
    },
    // Issue #746 (epic #738 platform-evolution Wave 2) — business-scope
    // assignments/SoD review admin screens.
    {
      labelKey: "admin.layout.nav_business_scope",
      path: "/admin/business-scope",
      order: 56,
      requiredPermission: "identity_access.business_scope_assignments.read"
    }
  ],
  jobs: [
    {
      command: "bun run identity-access:business-scope:expiry",
      purpose:
        "Transitions business-scope assignments and SoD conflict exceptions past their effective_to to expired, recording lifecycle events.",
      recommendedSchedule: "Hourly via cron/systemd timer.",
      environmentNotes:
        "Database-only operation, no external network dependency.",
      safeInOfflineLan: true
    }
  ],
  // Issue #746 — two of this issue's three real SoD rule fixtures are
  // owned by identity_access itself (the third is data_lifecycle's own
  // legal_hold.create/.release, `data-lifecycle/module.ts`); see this
  // issue's PR description for why a third-module pair was not forced —
  // `identity_access` owning a second, scope-level rule is the explicitly
  // sanctioned fallback (issue #746 brief) over inventing a contrived
  // cross-module example.
  sodRules: [
    {
      ruleKey: "identity_access.business_scope_exception_maker_checker",
      ownerModuleKey: "identity_access",
      description:
        "A subject who can REQUEST a segregation-of-duties conflict exception must not also be able to APPROVE one — maker/checker over the override mechanism itself. Global-within-tenant: holding both permissions anywhere in the tenant is itself the conflict, no shared business scope required.",
      conflictingPermissionKeys: [
        "identity_access.business_scope_exceptions.create",
        "identity_access.business_scope_exceptions.approve"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "high",
      // Deliberately NOT exception-able: allowing an override of the
      // control that gates SoD overrides themselves would let a single
      // role recursively bypass the whole exception flow.
      exceptionPolicy: { allowed: false }
    },
    {
      ruleKey: "identity_access.business_scope_assignment_scope_maker_checker",
      ownerModuleKey: "identity_access",
      description:
        "A subject who can CREATE a business-scope assignment at a given scope must not also be able to REVOKE an assignment at that SAME scope — requester/administrator separation over a single scope's access grants. Same-scope-only: the conflict only applies when both permissions would apply to the identical (scopeType, scopeId), not merely anywhere in the tenant.",
      conflictingPermissionKeys: [
        "identity_access.business_scope_assignments.create",
        "identity_access.business_scope_assignments.revoke"
      ],
      scopeApplicability: "same_scope_only",
      severity: "medium",
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission:
          "identity_access.business_scope_exceptions.approve",
        maxDurationDays: 30
      }
    }
  ]
});
