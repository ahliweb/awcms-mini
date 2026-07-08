import { describe, expect, test } from "bun:test";

import { getModuleByKey, listModules } from "../../src/modules";
import { tenantDomainModule } from "../../src/modules/tenant-domain/module";

// Issue #558 (epic #555) — the six permissions seeded by
// sql/032_awcms_mini_tenant_domain_permissions.sql, verbatim. The
// descriptor's `permissions` array must match this list exactly
// (activityCode/action/description) or Module Management's permission
// sync/status report will show `missing`/`mismatched_description` for
// this module.
const MIGRATION_032_PERMISSIONS = [
  {
    activityCode: "domains",
    action: "read",
    description: "Read tenant domain/subdomain mappings"
  },
  {
    activityCode: "domains",
    action: "create",
    description: "Add a tenant domain/subdomain mapping"
  },
  {
    activityCode: "domains",
    action: "update",
    description: "Update a tenant domain/subdomain mapping"
  },
  {
    activityCode: "domains",
    action: "delete",
    description: "Soft delete a tenant domain/subdomain mapping"
  },
  {
    activityCode: "domains",
    action: "verify",
    description: "Verify ownership of a tenant domain/subdomain"
  },
  {
    activityCode: "domains",
    action: "set_primary",
    description: "Set a tenant domain as the active primary domain"
  }
];

describe("tenant_domain module descriptor (Issue #558)", () => {
  test("listModules() includes tenant_domain", () => {
    expect(listModules().some((m) => m.key === "tenant_domain")).toBe(true);
    expect(getModuleByKey("tenant_domain")).toBe(tenantDomainModule);
  });

  test("descriptor shape matches the issue's requirements", () => {
    expect(tenantDomainModule.key).toBe("tenant_domain");
    expect(tenantDomainModule.status).toBe("active");
    // "system" (not "domain"/"integration") — routing infrastructure
    // shared by every tenant, not a business feature and not defined by
    // an external provider integration (see module.ts's own comment for
    // the full reasoning).
    expect(tenantDomainModule.type).toBe("system");
    expect(tenantDomainModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access"
    ]);
  });

  test("api.basePath matches the issue's requirement", () => {
    expect(tenantDomainModule.api?.basePath).toBe("/api/v1/tenant/domains");
    expect(tenantDomainModule.api?.openApiPath).toBe(
      "openapi/awcms-mini-public-api.openapi.yaml"
    );
  });

  test("navigation.path matches the issue's requirement and is permission-gated", () => {
    expect(tenantDomainModule.navigation).toHaveLength(1);
    expect(tenantDomainModule.navigation?.[0]?.path).toBe(
      "/admin/tenant/domains"
    );
    expect(tenantDomainModule.navigation?.[0]?.requiredPermission).toBe(
      "tenant_domain.domains.read"
    );
  });

  test("permissions array matches migration 032's seed exactly", () => {
    expect(tenantDomainModule.permissions).toEqual(MIGRATION_032_PERMISSIONS);
  });

  test("permissions use the same module_key/activity_code the migration seeded", () => {
    // permissionKey convention used across the codebase is
    // `${moduleKey}.${activityCode}.${action}` — assert the descriptor's
    // own key plus every permission entry reproduces exactly the six
    // `tenant_domain.domains.*` keys the migration seeded.
    const permissionKeys = (tenantDomainModule.permissions ?? []).map(
      (p) => `${tenantDomainModule.key}.${p.activityCode}.${p.action}`
    );

    expect(permissionKeys).toEqual([
      "tenant_domain.domains.read",
      "tenant_domain.domains.create",
      "tenant_domain.domains.update",
      "tenant_domain.domains.delete",
      "tenant_domain.domains.verify",
      "tenant_domain.domains.set_primary"
    ]);
  });

  test("settings.defaults only sets manual DNS verification mode, nothing provider-specific", () => {
    expect(tenantDomainModule.settings?.defaults).toEqual({
      defaultVerificationMethod: "manual"
    });
  });

  test("settings.defaults never contains a secret-shaped key or value", () => {
    const defaults = tenantDomainModule.settings?.defaults ?? {};
    const serialized = JSON.stringify(defaults).toLowerCase();

    for (const forbidden of [
      "password",
      "token",
      "secret",
      "credential",
      "apikey",
      "api_key"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // The only allowed default value is the manual verification mode —
    // never an automated provider mode (Cloudflare, #567, is opt-in only
    // and out of scope for this issue).
    expect(defaults).not.toHaveProperty("provider");
    expect(defaults).not.toHaveProperty("cloudflareApiToken");
  });

  test("the module never declares jobs or health before those capabilities are real", () => {
    // Consistent with module_management's own README convention: a
    // descriptor should only claim jobs/health once the corresponding
    // feature exists. Neither exists for tenant_domain as of Issue #558.
    expect(tenantDomainModule.jobs).toBeUndefined();
    expect(tenantDomainModule.health).toBeUndefined();
  });
});
