/**
 * PR #839 security review, HIGH 1 — the SSR side of the descriptor
 * `requiredPermission` / `rawValuePermission` gates.
 *
 * `src/pages/admin/data-exchange/imports/[id].astro` does not go through the
 * preview route; it queries and projects staged rows itself. It replicated
 * the raw-value decision but never made the `requiredPermission` one, so a
 * descriptor owned by another module (`hr.payroll.read`) was enforced by all
 * six API routes and by nothing in the UI. This pins the decision function
 * the page now shares with those routes.
 *
 * The module-enabled axis (the review's SECOND parity finding) is pinned
 * against a REAL tenant + a real `awcms_mini_tenant_modules` row in
 * `tests/integration/data-exchange.integration.test.ts` — the fake `tx` here
 * can only prove the function asks the question, not that its answer matches
 * what the route computes.
 *
 * `.astro` files are outside `tsc`'s reach (see the repo's own note on this),
 * so the page's use of these helpers is additionally exercised end-to-end
 * there and by a live-server pass — a green typecheck proves nothing about
 * that file.
 */
import { describe, expect, test } from "bun:test";

import { isDescriptorPermissionGranted } from "../../src/modules/data-exchange/application/descriptor-authorization";

const BROAD = new Set(["data_exchange.imports.read"]);
const TENANT = "00000000-0000-0000-0000-0000000000aa";

/**
 * `resolveModuleEnabled` issues one tagged-template query and reads
 * `rows[0]?.enabled ?? true`. A tagged template is just a call, so a plain
 * function stands in for `Bun.SQL` here; `[]` reproduces the real "no row =
 * enabled by default" convention.
 */
function fakeTx(rows: { enabled: boolean }[]): Bun.SQL {
  return (() => Promise.resolve(rows)) as unknown as Bun.SQL;
}

const ENABLED = fakeTx([{ enabled: true }]);
const DISABLED = fakeTx([{ enabled: false }]);
const NO_ROW = fakeTx([]);

describe("isDescriptorPermissionGranted", () => {
  test("allows when the descriptor declares no extra requirement", async () => {
    expect(
      await isDescriptorPermissionGranted(ENABLED, TENANT, BROAD, undefined)
    ).toBe(true);
  });

  test("denies the generic data_exchange reader a descriptor's own permission", async () => {
    expect(
      await isDescriptorPermissionGranted(
        ENABLED,
        TENANT,
        BROAD,
        "hr.payroll.read"
      )
    ).toBe(false);
  });

  test("allows the holder of the descriptor's own permission", async () => {
    const permissions = new Set([
      "data_exchange.imports.read",
      "hr.payroll.read"
    ]);

    expect(
      await isDescriptorPermissionGranted(
        ENABLED,
        TENANT,
        permissions,
        "hr.payroll.read"
      )
    ).toBe(true);
  });

  test("a broad permission set never substitutes for the declared key", async () => {
    const permissions = new Set([
      "data_exchange.imports.read",
      "data_exchange.imports.manage",
      "data_exchange.preview_errors.read"
    ]);

    expect(
      await isDescriptorPermissionGranted(
        ENABLED,
        TENANT,
        permissions,
        "hr.payroll.read"
      )
    ).toBe(false);
  });

  /**
   * The review's second parity finding. `fetchGrantedPermissionKeys` does not
   * filter disabled modules, so the subject genuinely still HOLDS
   * `hr.payroll.read` here — `permissions.has()` alone said yes while the
   * route said `403 MODULE_DISABLED`.
   */
  test("denies a held permission whose module the tenant has disabled", async () => {
    const permissions = new Set([
      "data_exchange.imports.read",
      "hr.payroll.read"
    ]);

    expect(permissions.has("hr.payroll.read")).toBe(true);
    expect(
      await isDescriptorPermissionGranted(
        DISABLED,
        TENANT,
        permissions,
        "hr.payroll.read"
      )
    ).toBe(false);
  });

  test("no tenant_modules row means enabled, matching resolveModuleEnabled's default", async () => {
    const permissions = new Set(["hr.payroll.read"]);

    expect(
      await isDescriptorPermissionGranted(
        NO_ROW,
        TENANT,
        permissions,
        "hr.payroll.read"
      )
    ).toBe(true);
  });

  test("checks module state BEFORE RBAC, as authorizeInTransaction orders it", async () => {
    expect(
      await isDescriptorPermissionGranted(
        DISABLED,
        TENANT,
        new Set(),
        "hr.payroll.read"
      )
    ).toBe(false);
  });

  /**
   * Fails CLOSED, exactly as `authorizeDescriptorPermissionKey` does on the
   * route path (it answers 500 there rather than skipping the check). A
   * declaration the base cannot parse is never downgraded to "no
   * requirement" — the empty-segment cases matter because `"a..b".split(".")`
   * still has length 3.
   */
  test.each([
    ["hr.payroll", "too few segments"],
    ["hr.payroll.read.extra", "too many segments"],
    ["", "empty"],
    ["..", "all segments empty"],
    ["hr..read", "empty middle segment"],
    [".payroll.read", "empty leading segment"],
    ["hr.payroll.", "empty trailing segment"]
  ])("denies a malformed key (%s — %s)", async (key) => {
    expect(
      await isDescriptorPermissionGranted(ENABLED, TENANT, BROAD, key)
    ).toBe(false);
  });

  test("a malformed key is denied even to a caller literally holding that string", async () => {
    expect(
      await isDescriptorPermissionGranted(
        ENABLED,
        TENANT,
        new Set(["hr.payroll"]),
        "hr.payroll"
      )
    ).toBe(false);
  });

  test("denies everything to a caller with no permissions at all", async () => {
    expect(
      await isDescriptorPermissionGranted(
        ENABLED,
        TENANT,
        new Set(),
        "hr.payroll.read"
      )
    ).toBe(false);
  });
});
