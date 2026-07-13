/**
 * Unit tests for business-scope assignment domain validation (Issue #746)
 * — pure, no I/O, no database.
 */
import { describe, expect, test } from "bun:test";

import {
  isBusinessScopeAssignmentCurrentlyActive,
  validateCreateBusinessScopeAssignmentInput,
  validateRevokeBusinessScopeAssignmentInput
} from "../../src/modules/identity-access/domain/business-scope-assignment";

const BASE_INPUT = {
  tenantUserId: "11111111-1111-1111-1111-111111111111",
  roleId: null,
  scopeType: "office",
  scopeId: "22222222-2222-2222-2222-222222222222",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  isTemporary: false,
  reason: null
};

describe("validateCreateBusinessScopeAssignmentInput", () => {
  test("accepts a well-formed permanent assignment", () => {
    expect(validateCreateBusinessScopeAssignmentInput(BASE_INPUT)).toEqual([]);
  });

  test("rejects a temporary assignment with no effectiveTo — must have an end date", () => {
    const errors = validateCreateBusinessScopeAssignmentInput({
      ...BASE_INPUT,
      isTemporary: true,
      effectiveTo: null
    });
    expect(errors.some((e) => e.field === "effectiveTo")).toBe(true);
  });

  test("accepts a temporary assignment with a valid effectiveTo", () => {
    const errors = validateCreateBusinessScopeAssignmentInput({
      ...BASE_INPUT,
      isTemporary: true,
      effectiveTo: new Date("2026-02-01T00:00:00Z")
    });
    expect(errors).toEqual([]);
  });

  test("rejects effectiveTo <= effectiveFrom", () => {
    const errors = validateCreateBusinessScopeAssignmentInput({
      ...BASE_INPUT,
      effectiveTo: new Date("2025-12-31T00:00:00Z")
    });
    expect(errors.some((e) => e.field === "effectiveTo")).toBe(true);
  });

  test("rejects an empty scopeType", () => {
    const errors = validateCreateBusinessScopeAssignmentInput({
      ...BASE_INPUT,
      scopeType: ""
    });
    expect(errors.some((e) => e.field === "scopeType")).toBe(true);
  });

  test("rejects a non-snake_case scopeType", () => {
    const errors = validateCreateBusinessScopeAssignmentInput({
      ...BASE_INPUT,
      scopeType: "Office-1"
    });
    expect(errors.some((e) => e.field === "scopeType")).toBe(true);
  });

  test("rejects a missing scopeId", () => {
    const errors = validateCreateBusinessScopeAssignmentInput({
      ...BASE_INPUT,
      scopeId: ""
    });
    expect(errors.some((e) => e.field === "scopeId")).toBe(true);
  });
});

describe("validateRevokeBusinessScopeAssignmentInput", () => {
  test("rejects an empty revokeReason", () => {
    const errors = validateRevokeBusinessScopeAssignmentInput({
      revokeReason: ""
    });
    expect(errors.some((e) => e.field === "revokeReason")).toBe(true);
  });

  test("accepts a non-empty revokeReason", () => {
    expect(
      validateRevokeBusinessScopeAssignmentInput({
        revokeReason: "No longer needed."
      })
    ).toEqual([]);
  });
});

describe("isBusinessScopeAssignmentCurrentlyActive", () => {
  const now = new Date("2026-06-15T00:00:00Z");

  test("an active row within its effective window is active", () => {
    expect(
      isBusinessScopeAssignmentCurrentlyActive(
        {
          status: "active",
          effectiveFrom: new Date("2026-06-01T00:00:00Z"),
          effectiveTo: new Date("2026-06-30T00:00:00Z")
        },
        now
      )
    ).toBe(true);
  });

  test("an active row with no effectiveTo (indefinite) is active once effectiveFrom has passed", () => {
    expect(
      isBusinessScopeAssignmentCurrentlyActive(
        {
          status: "active",
          effectiveFrom: new Date("2026-06-01T00:00:00Z"),
          effectiveTo: null
        },
        now
      )
    ).toBe(true);
  });

  test("status='active' but effectiveTo already passed is NOT currently active — status is a cache, timestamp is the real gate", () => {
    expect(
      isBusinessScopeAssignmentCurrentlyActive(
        {
          status: "active",
          effectiveFrom: new Date("2026-05-01T00:00:00Z"),
          effectiveTo: new Date("2026-06-01T00:00:00Z")
        },
        now
      )
    ).toBe(false);
  });

  test("a not-yet-effective row (effectiveFrom in the future) is NOT currently active", () => {
    expect(
      isBusinessScopeAssignmentCurrentlyActive(
        {
          status: "active",
          effectiveFrom: new Date("2026-07-01T00:00:00Z"),
          effectiveTo: null
        },
        now
      )
    ).toBe(false);
  });

  test("expired/revoked status is never active regardless of timestamps", () => {
    for (const status of ["expired", "revoked"] as const) {
      expect(
        isBusinessScopeAssignmentCurrentlyActive(
          {
            status,
            effectiveFrom: new Date("2026-06-01T00:00:00Z"),
            effectiveTo: new Date("2026-06-30T00:00:00Z")
          },
          now
        )
      ).toBe(false);
    }
  });
});
