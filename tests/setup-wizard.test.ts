import { describe, expect, test } from "bun:test";

import { validateSetupInitializeInput } from "../src/modules/tenant-admin/domain/setup-validation";

const VALID_INPUT = {
  tenantCode: "acme",
  tenantName: "Acme Inc",
  officeCode: "hq",
  officeName: "Head Office",
  ownerLoginIdentifier: "owner@example.com",
  ownerPassword: "correct horse battery staple",
  ownerDisplayName: "Jane Owner"
};

describe("validateSetupInitializeInput", () => {
  test("accepts a fully populated request and trims string fields", () => {
    const result = validateSetupInitializeInput({
      ...VALID_INPUT,
      tenantCode: "  acme  "
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.tenantCode).toBe("acme");
      expect(result.value.ownerPassword).toBe(VALID_INPUT.ownerPassword);
    }
  });

  test("rejects a missing body", () => {
    const result = validateSetupInitializeInput(null);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("reports every missing required field", () => {
    const result = validateSetupInitializeInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.field).sort()).toEqual(
        [
          "tenantCode",
          "tenantName",
          "officeCode",
          "officeName",
          "ownerLoginIdentifier",
          "ownerPassword",
          "ownerDisplayName"
        ].sort()
      );
    }
  });

  test("rejects blank (whitespace-only) fields", () => {
    const result = validateSetupInitializeInput({
      ...VALID_INPUT,
      tenantName: "   "
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "tenantName",
        message: "tenantName is required."
      });
    }
  });

  test("enforces a minimum password length", () => {
    const result = validateSetupInitializeInput({
      ...VALID_INPUT,
      ownerPassword: "short"
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "ownerPassword",
        message: "ownerPassword must be at least 8 characters."
      });
    }
  });
});
