/**
 * Unit tests for versioned scale profiles (Issue #744, epic #738). Pure —
 * asserts the documented row/tenant distribution invariants the issue's
 * "documents row/tenant distributions" acceptance criterion depends on.
 */
import { describe, expect, test } from "bun:test";

import {
  LARGE_SCALE_PROFILE,
  resolveScaleProfile,
  SAFE_SCALE_PROFILE,
  STANDARD_SCALE_PROFILE,
  totalRowCount
} from "../../src/lib/performance/scale-profiles";

describe("scale profiles", () => {
  test("safe profile stays small (CI/PR-safe)", () => {
    expect(SAFE_SCALE_PROFILE.tenantCount).toBeLessThanOrEqual(10);
    expect(SAFE_SCALE_PROFILE.soakDurationMs).toBe(0);
  });

  test("standard and large profiles are strictly bigger than safe", () => {
    expect(STANDARD_SCALE_PROFILE.tenantCount).toBeGreaterThan(
      SAFE_SCALE_PROFILE.tenantCount
    );
    expect(LARGE_SCALE_PROFILE.tenantCount).toBeGreaterThan(
      STANDARD_SCALE_PROFILE.tenantCount
    );
    expect(totalRowCount(LARGE_SCALE_PROFILE)).toBeGreaterThan(
      totalRowCount(STANDARD_SCALE_PROFILE)
    );
    expect(totalRowCount(STANDARD_SCALE_PROFILE)).toBeGreaterThan(
      totalRowCount(SAFE_SCALE_PROFILE)
    );
  });

  test("every profile designates a noisy-neighbor multiplier > 1", () => {
    for (const profile of [
      SAFE_SCALE_PROFILE,
      STANDARD_SCALE_PROFILE,
      LARGE_SCALE_PROFILE
    ]) {
      expect(profile.noisyNeighborMultiplier).toBeGreaterThan(1);
    }
  });

  test("only standard/large profiles configure a soak duration", () => {
    expect(STANDARD_SCALE_PROFILE.soakDurationMs).toBeGreaterThan(0);
    expect(LARGE_SCALE_PROFILE.soakDurationMs).toBeGreaterThan(0);
  });

  test("resolveScaleProfile falls back to safe for an unknown/missing id", () => {
    expect(resolveScaleProfile(undefined)).toBe(SAFE_SCALE_PROFILE);
    expect(resolveScaleProfile("bogus")).toBe(SAFE_SCALE_PROFILE);
  });

  test("resolveScaleProfile resolves known ids", () => {
    expect(resolveScaleProfile("standard")).toBe(STANDARD_SCALE_PROFILE);
    expect(resolveScaleProfile("large")).toBe(LARGE_SCALE_PROFILE);
  });

  test("totalRowCount accounts for the noisy-neighbor multiplier", () => {
    const perTenantTotal = Object.values(
      SAFE_SCALE_PROFILE.rowsPerTenant
    ).reduce((sum, count) => sum + count, 0);
    const expected =
      perTenantTotal * (SAFE_SCALE_PROFILE.tenantCount - 1) +
      perTenantTotal * SAFE_SCALE_PROFILE.noisyNeighborMultiplier;

    expect(totalRowCount(SAFE_SCALE_PROFILE)).toBe(expected);
  });
});
