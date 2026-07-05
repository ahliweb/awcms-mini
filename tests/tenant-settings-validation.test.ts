import { describe, expect, test } from "bun:test";

import { validateUpdateTenantSettingsInput } from "../src/modules/tenant-admin/domain/settings-validation";

describe("validateUpdateTenantSettingsInput", () => {
  test("accepts a tenantName-only update and trims it", () => {
    const result = validateUpdateTenantSettingsInput({
      tenantName: "  Acme Inc  "
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ tenantName: "Acme Inc" });
    }
  });

  test("accepts legalName: null (clearing it)", () => {
    const result = validateUpdateTenantSettingsInput({ legalName: null });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ legalName: null });
    }
  });

  test("accepts a valid defaultLocale and defaultTheme", () => {
    const result = validateUpdateTenantSettingsInput({
      defaultLocale: "en",
      defaultTheme: "dark"
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({
        defaultLocale: "en",
        defaultTheme: "dark"
      });
    }
  });

  test("rejects an invalid defaultLocale", () => {
    const result = validateUpdateTenantSettingsInput({
      defaultLocale: "fr"
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "defaultLocale",
        message: "defaultLocale must be one of id, en, ms, ar."
      });
    }
  });

  test("rejects an invalid defaultTheme", () => {
    const result = validateUpdateTenantSettingsInput({
      defaultTheme: "solarized"
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "defaultTheme",
        message: "defaultTheme must be one of light, dark, system."
      });
    }
  });

  test("accepts a valid featureFlags object", () => {
    const result = validateUpdateTenantSettingsInput({
      featureFlags: { betaReports: true }
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.featureFlags).toEqual({ betaReports: true });
    }
  });

  test("rejects featureFlags that is an array", () => {
    const result = validateUpdateTenantSettingsInput({
      featureFlags: ["not", "an", "object"]
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "featureFlags",
        message: "featureFlags must be a JSON object."
      });
    }
  });

  test("rejects featureFlags that is a primitive", () => {
    const result = validateUpdateTenantSettingsInput({ featureFlags: "on" });

    expect(result.valid).toBe(false);
  });

  test("rejects an empty timezone string", () => {
    const result = validateUpdateTenantSettingsInput({ timezone: "   " });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "timezone",
        message: "timezone must be a non-empty string."
      });
    }
  });

  test("rejects an empty body (nothing to update)", () => {
    const result = validateUpdateTenantSettingsInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "body",
        message:
          "Provide at least one of tenantName, legalName, defaultLocale, defaultTheme, timezone, featureFlags."
      });
    }
  });

  test("rejects a null body", () => {
    expect(validateUpdateTenantSettingsInput(null).valid).toBe(false);
  });
});
