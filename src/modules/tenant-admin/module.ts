import { defineModule } from "../_shared/module-contract";

export const tenantAdminModule = defineModule({
  key: "tenant_admin",
  name: "Tenant Admin",
  version: "1.0.0",
  status: "active",
  description:
    "Tenant root entity, office hierarchy, physical locations, tenant settings, and the one-time setup wizard that bootstraps the first tenant, owner, office, role, and access assignment. `dependencies` is deliberately empty (Issue #680, epic #679) — this module previously declared [\"profile_identity\", \"identity_access\"], which together with those two modules' own declarations formed a live 3-node cycle (tenant_admin -> profile_identity -> tenant_admin, tenant_admin -> identity_access -> profile_identity -> tenant_admin) that `domain/tenant-module-lifecycle.ts`'s own `hasDependencyCycle` would reject if anyone ever tried to enable one of these three modules through the normal lifecycle path. The real reason this module previously listed those two: its setup wizard (`POST /api/v1/setup/initialize`) writes rows into profile_identity's and identity_access's tables in the SAME bootstrap transaction — a call-time orchestration concern, not a static \"this module cannot function without that one\" dependency. That orchestration now lives in `application/platform-bootstrap.ts`'s `bootstrapPlatformTenant`, an explicit composition-root function the route handler calls directly — module dependency edges no longer express it. See `.claude/skills/awcms-mini-module-management/SKILL.md`'s §Dependency graph section.",
  dependencies: [],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/setup"
  }
});
