/**
 * PR #839 security review, HIGH 1 — the SSR side of the descriptor
 * `requiredPermission` gate.
 *
 * `src/pages/admin/data-exchange/imports/[id].astro` does not go through the
 * preview route; it queries and projects staged rows itself. It replicated
 * the raw-value decision but never made the `requiredPermission` one, so a
 * descriptor owned by another module (`hr.payroll.read`) was enforced by all
 * six API routes and by nothing in the UI. This pins the decision function
 * the page now shares with those routes.
 *
 * `.astro` files are outside `tsc`'s reach (see the repo's own note on this),
 * so the page's use of it is additionally exercised end-to-end in
 * `tests/integration/data-exchange.integration.test.ts` — a green typecheck
 * proves nothing about that file.
 */
import { describe, expect, test } from "bun:test";

import { isDescriptorPermissionGranted } from "../../src/modules/data-exchange/application/descriptor-authorization";

const BROAD = new Set(["data_exchange.imports.read"]);

describe("isDescriptorPermissionGranted", () => {
  test("allows when the descriptor declares no extra requirement", () => {
    expect(isDescriptorPermissionGranted(BROAD, undefined)).toBe(true);
  });

  test("denies the generic data_exchange reader a descriptor's own permission", () => {
    expect(isDescriptorPermissionGranted(BROAD, "hr.payroll.read")).toBe(false);
  });

  test("allows the holder of the descriptor's own permission", () => {
    const permissions = new Set([
      "data_exchange.imports.read",
      "hr.payroll.read"
    ]);

    expect(isDescriptorPermissionGranted(permissions, "hr.payroll.read")).toBe(
      true
    );
  });

  test("a broad permission set never substitutes for the declared key", () => {
    const permissions = new Set([
      "data_exchange.imports.read",
      "data_exchange.imports.manage",
      "data_exchange.preview_errors.read"
    ]);

    expect(isDescriptorPermissionGranted(permissions, "hr.payroll.read")).toBe(
      false
    );
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
  ])("denies a malformed key (%s — %s)", (key) => {
    expect(isDescriptorPermissionGranted(BROAD, key)).toBe(false);
  });

  test("a malformed key is denied even to a caller literally holding that string", () => {
    expect(
      isDescriptorPermissionGranted(new Set(["hr.payroll"]), "hr.payroll")
    ).toBe(false);
  });

  test("denies everything to a caller with no permissions at all", () => {
    expect(isDescriptorPermissionGranted(new Set(), "hr.payroll.read")).toBe(
      false
    );
  });
});
