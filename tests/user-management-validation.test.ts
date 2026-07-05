import { describe, expect, test } from "bun:test";

import {
  validateCreateRoleInput,
  validateCreateUserInput,
  validateUpdateRoleInput,
  validateUpdateUserInput
} from "../src/modules/identity-access/domain/user-management";

const VALID_ROLE_ID = "8d613419-68de-442b-8b85-56dc1c99ba45";
const VALID_PERMISSION_ID = "9e7ac3c0-9ead-462e-9a06-91bc6f00e123";

describe("validateCreateUserInput", () => {
  test("accepts a fully populated request and trims/dedupes roleIds", () => {
    const result = validateCreateUserInput({
      displayName: "  Jane  ",
      loginIdentifier: "jane@example.com",
      password: "correct horse battery staple",
      roleIds: [VALID_ROLE_ID, VALID_ROLE_ID]
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.displayName).toBe("Jane");
      expect(result.value.roleIds).toEqual([VALID_ROLE_ID]);
    }
  });

  test("defaults roleIds to an empty array when omitted", () => {
    const result = validateCreateUserInput({
      displayName: "Jane",
      loginIdentifier: "jane@example.com",
      password: "correct horse battery staple"
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.roleIds).toEqual([]);
    }
  });

  test("reports every missing required field", () => {
    const result = validateCreateUserInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.field).sort()).toEqual(
        ["displayName", "loginIdentifier", "password"].sort()
      );
    }
  });

  test("enforces a minimum password length", () => {
    const result = validateCreateUserInput({
      displayName: "Jane",
      loginIdentifier: "jane@example.com",
      password: "short"
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "password",
        message: "password must be at least 8 characters."
      });
    }
  });

  test("rejects a non-UUID entry in roleIds", () => {
    const result = validateCreateUserInput({
      displayName: "Jane",
      loginIdentifier: "jane@example.com",
      password: "correct horse battery staple",
      roleIds: ["not-a-uuid"]
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "roleIds",
        message: "roleIds must contain valid UUID ids."
      });
    }
  });

  test("rejects roleIds that is not an array", () => {
    const result = validateCreateUserInput({
      displayName: "Jane",
      loginIdentifier: "jane@example.com",
      password: "correct horse battery staple",
      roleIds: "not-an-array"
    });

    expect(result.valid).toBe(false);
  });
});

describe("validateUpdateUserInput", () => {
  test("accepts a displayName-only update", () => {
    const result = validateUpdateUserInput({ displayName: "New Name" });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ displayName: "New Name" });
    }
  });

  test("accepts a status-only update", () => {
    const result = validateUpdateUserInput({ status: "inactive" });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ status: "inactive" });
    }
  });

  test("rejects an empty body (nothing to update)", () => {
    const result = validateUpdateUserInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "body",
        message: "Provide at least one of displayName or status."
      });
    }
  });

  test("rejects an invalid status value", () => {
    const result = validateUpdateUserInput({ status: "banned" });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "status",
        message: "status must be 'active' or 'inactive'."
      });
    }
  });
});

describe("validateCreateRoleInput", () => {
  test("accepts a valid role and trims fields", () => {
    const result = validateCreateRoleInput({
      roleCode: "  viewer  ",
      roleName: "Viewer",
      permissionIds: [VALID_PERMISSION_ID]
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.roleCode).toBe("viewer");
      expect(result.value.permissionIds).toEqual([VALID_PERMISSION_ID]);
    }
  });

  test("rejects an uppercase/invalid roleCode", () => {
    const result = validateCreateRoleInput({
      roleCode: "Viewer-1",
      roleName: "Viewer"
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "roleCode")).toBe(true);
    }
  });

  test("reports every missing required field", () => {
    const result = validateCreateRoleInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.field).sort()).toEqual(
        ["roleCode", "roleName"].sort()
      );
    }
  });
});

describe("validateUpdateRoleInput", () => {
  test("accepts a roleName-only update", () => {
    const result = validateUpdateRoleInput({ roleName: "Renamed" });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ roleName: "Renamed" });
    }
  });

  test("accepts an empty permissionIds array (clears permissions)", () => {
    const result = validateUpdateRoleInput({ permissionIds: [] });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.permissionIds).toEqual([]);
    }
  });

  test("rejects an empty body (nothing to update)", () => {
    const result = validateUpdateRoleInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "body",
        message: "Provide at least one of roleName or permissionIds."
      });
    }
  });
});
