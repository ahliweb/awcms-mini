import { describe, expect, test } from "bun:test";

import { getModuleByKey, listModules } from "../../src/modules";
import { idnAdminRegionsModule } from "../../src/modules/idn-admin-regions/module";

// Issue #655 — the five permissions seeded by
// sql/048_awcms_mini_idn_admin_regions_permissions.sql, verbatim. The
// descriptor's `permissions` array must match this list exactly
// (activityCode/action/description) or Module Management's permission
// sync/status report will show `missing`/`mismatched_description` for
// this module.
const MIGRATION_048_PERMISSIONS = [
  {
    activityCode: "region",
    action: "read",
    description: "Read Indonesia administrative region records"
  },
  {
    activityCode: "dataset",
    action: "read",
    description: "Read Indonesia administrative region dataset metadata"
  },
  {
    activityCode: "dataset",
    action: "import",
    description: "Import a new Indonesia administrative region dataset"
  },
  {
    activityCode: "dataset",
    action: "activate",
    description: "Activate a validated Indonesia administrative region dataset"
  },
  {
    activityCode: "dataset",
    action: "rollback",
    description:
      "Roll back the active Indonesia administrative region dataset to the previously active one"
  }
];

describe("idn_admin_regions module descriptor (Issue #655)", () => {
  test("listModules() includes idn_admin_regions", () => {
    expect(listModules().some((m) => m.key === "idn_admin_regions")).toBe(true);
    expect(getModuleByKey("idn_admin_regions")).toBe(idnAdminRegionsModule);
  });

  test("descriptor shape matches the issue's requirements", () => {
    expect(idnAdminRegionsModule.key).toBe("idn_admin_regions");
    expect(idnAdminRegionsModule.name).toBe("Indonesia Administrative Regions");
    expect(idnAdminRegionsModule.version).toBe("0.1.0");
    expect(idnAdminRegionsModule.status).toBe("experimental");
    expect(idnAdminRegionsModule.type).toBe("base");
    expect(idnAdminRegionsModule.dependencies).toEqual([
      "identity_access",
      "logging",
      "module_management"
    ]);
  });

  test("permissions array matches migration 048's seed exactly", () => {
    expect(idnAdminRegionsModule.permissions).toEqual(
      MIGRATION_048_PERMISSIONS
    );
  });

  test("permissions use the same module_key/activity_code the migration seeded", () => {
    const permissionKeys = (idnAdminRegionsModule.permissions ?? []).map(
      (p) => `${idnAdminRegionsModule.key}.${p.activityCode}.${p.action}`
    );

    expect(permissionKeys).toEqual([
      "idn_admin_regions.region.read",
      "idn_admin_regions.dataset.read",
      "idn_admin_regions.dataset.import",
      "idn_admin_regions.dataset.activate",
      "idn_admin_regions.dataset.rollback"
    ]);
  });

  test("descriptor never declares a secret, token, or provider credential", () => {
    const serialized = JSON.stringify(idnAdminRegionsModule).toLowerCase();

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
  });

  test("the module never declares api, navigation, jobs, health, or settings before those capabilities are real (Issue #655 is scaffold-only)", () => {
    // Consistent with visitor_analytics/news_portal's own precedent: a
    // descriptor should only claim a capability once the corresponding
    // feature exists. None of these exist for idn_admin_regions as of
    // Issue #655 — schema lands in #657, the lookup API in #662, the
    // admin UI (and its navigation entry) in #663.
    expect(idnAdminRegionsModule.api).toBeUndefined();
    expect(idnAdminRegionsModule.navigation).toBeUndefined();
    expect(idnAdminRegionsModule.jobs).toBeUndefined();
    expect(idnAdminRegionsModule.health).toBeUndefined();
    expect(idnAdminRegionsModule.settings).toBeUndefined();
    expect(idnAdminRegionsModule.events).toBeUndefined();
  });
});
