/**
 * Default-disabled control-plane gate (Issue #870, epic #868 SaaS control
 * plane, ADR-0022 §7 / Medium-3).
 *
 * WHY THIS FILE EXISTS. ADR-0022 §7 makes "default-disabled" a REQUIREMENT for
 * the seven SaaS control-plane modules, and Medium-3 is explicit that a flag
 * alone is not enough — an issue introducing `defaultTenantState: "disabled"`
 * MUST also ship a test that FAILS if any control-plane key resolves `enabled`
 * without an explicit `awcms_mini_tenant_modules` row. The ground truth it
 * pins: `module-management/domain/tenant-module-lifecycle.ts` (and the runtime
 * resolvers `resolveModuleEnabled`, the SSR permission gate, the nav registry,
 * the tenant-module matrix) default a row-less module to ENABLED — so this
 * gate proves the seven control-plane modules are EXCLUDED from that default.
 *
 * A control-plane billing/entitlement module silently active on a LAN/offline
 * box is an attack surface + operational confusion (ADR-0022 §7/§10), not
 * cosmetics — so this is a gate, not prose.
 *
 * SCOPE. As of #870 only `service_catalog` is registered; #871-#877 add the
 * rest. The gate asserts EVERY control-plane key that IS registered is
 * default-disabled, and that `service_catalog` specifically is (so the gate is
 * never vacuous today). A future control-plane module that forgets
 * `defaultTenantState: "disabled"` fails here.
 */
import { describe, expect, test } from "bun:test";
import { getModuleByKey, listBaseModules } from "../../src/modules";
import {
  isModuleTenantEnabledByDefault,
  type ModuleDescriptor
} from "../../src/modules/_shared/module-contract";

/** The seven SaaS control-plane module keys (ADR-0022 §1). */
const CONTROL_PLANE_MODULE_KEYS = [
  "service_catalog",
  "tenant_entitlement",
  "tenant_provisioning",
  "tenant_lifecycle",
  "usage_metering",
  "subscription_billing",
  "payment_gateway"
] as const;

/** The exact fallback expression every runtime resolver uses (`resolveModuleEnabled`, the SSR gate, the tenant-module matrix): explicit row wins; a NULL/absent row resolves through the descriptor default. */
function resolveEnabled(
  rowEnabled: boolean | null | undefined,
  descriptor: ModuleDescriptor | undefined
): boolean {
  return rowEnabled ?? isModuleTenantEnabledByDefault(descriptor);
}

describe("default-disabled control-plane modules (Issue #870, ADR-0022 §7)", () => {
  test("service_catalog is registered AND default-disabled (the gate has a live subject today)", () => {
    const descriptor = getModuleByKey("service_catalog");
    expect(
      descriptor,
      "service_catalog must be registered in src/modules/index.ts"
    ).toBeDefined();
    expect(descriptor?.defaultTenantState).toBe("disabled");
    expect(isModuleTenantEnabledByDefault(descriptor)).toBe(false);
  });

  test("EVERY registered control-plane module resolves DISABLED with no explicit tenant_modules row", () => {
    const registered = CONTROL_PLANE_MODULE_KEYS.map((key) =>
      getModuleByKey(key)
    ).filter((d): d is ModuleDescriptor => d !== undefined);

    expect(
      registered.length,
      "At least service_catalog must be registered for this gate to bite."
    ).toBeGreaterThan(0);

    for (const descriptor of registered) {
      // This is exactly what resolveModuleEnabled returns for a row-less tenant.
      expect(
        resolveEnabled(null, descriptor),
        `Control-plane module "${descriptor.key}" resolves ENABLED without an explicit tenant_modules row. Set defaultTenantState: "disabled" in its module.ts — a control-plane module silently active on a LAN deployment is an attack surface (ADR-0022 §7).`
      ).toBe(false);
    }
  });

  test("an ordinary module stays default-enabled (the mechanism is not just always-false)", () => {
    const blog = getModuleByKey("blog_content");
    expect(blog).toBeDefined();
    expect(isModuleTenantEnabledByDefault(blog)).toBe(true);
    expect(resolveEnabled(null, blog)).toBe(true);
  });

  test("an explicit tenant_modules row always wins over the descriptor default (both directions)", () => {
    const controlPlane = getModuleByKey("service_catalog");
    // Explicit enable opts the control-plane module IN (the platform operator's tenant).
    expect(resolveEnabled(true, controlPlane)).toBe(true);
    // Explicit disable keeps it out.
    expect(resolveEnabled(false, controlPlane)).toBe(false);
  });

  test("no NON-control-plane base module accidentally opts into default-disabled", () => {
    const controlPlaneSet = new Set<string>(CONTROL_PLANE_MODULE_KEYS);
    const wrong = listBaseModules().filter(
      (descriptor) =>
        !controlPlaneSet.has(descriptor.key) &&
        descriptor.defaultTenantState === "disabled"
    );

    expect(
      wrong.map((d) => d.key),
      "Only the seven SaaS control-plane modules may be default-disabled. An ordinary module set to disabled would silently vanish for every tenant."
    ).toEqual([]);
  });
});
