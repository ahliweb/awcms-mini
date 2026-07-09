import { describe, expect, test } from "bun:test";

import { evaluateLoginAttempt } from "../../src/modules/identity-access/domain/login-policy";

const BASE_INPUT = {
  now: new Date("2026-01-01T00:00:00Z"),
  tenantStatus: "active",
  tenantUserStatus: "active" as const,
  passwordMatches: true,
  maxFailedAttempts: 5,
  lockoutMinutes: 15
};

describe("evaluateLoginAttempt — password_login_disabled (Issue #591)", () => {
  test("denies with password_login_disabled when the flag is set for an existing identity, even with a correct password", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      identity: { status: "active", failedLoginCount: 0, lockedUntil: null },
      passwordLoginDisabled: true
    });

    expect(result).toEqual({
      outcome: "deny",
      reason: "password_login_disabled"
    });
  });

  test("does not increment failed_login_count when denying for password_login_disabled", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      identity: { status: "active", failedLoginCount: 2, lockedUntil: null },
      passwordLoginDisabled: true
    });

    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.failedLoginCount).toBeUndefined();
    }
  });

  test("default (flag omitted) preserves existing behavior — allows a valid login", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      identity: { status: "active", failedLoginCount: 0, lockedUntil: null }
    });

    expect(result.outcome).toBe("allow");
  });

  test("flag false has no effect — still allows a valid login", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      identity: { status: "active", failedLoginCount: 0, lockedUntil: null },
      passwordLoginDisabled: false
    });

    expect(result.outcome).toBe("allow");
  });

  test("tenant_inactive takes priority over password_login_disabled", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      tenantStatus: "suspended",
      identity: { status: "active", failedLoginCount: 0, lockedUntil: null },
      passwordLoginDisabled: true
    });

    expect(result).toEqual({ outcome: "deny", reason: "tenant_inactive" });
  });

  test("locked takes priority over password_login_disabled", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      identity: { status: "locked", failedLoginCount: 0, lockedUntil: null },
      passwordLoginDisabled: true
    });

    expect(result).toEqual({ outcome: "deny", reason: "locked" });
  });

  test("passwordLoginDisabled with no identity resolved falls through to invalid_credentials (no account-existence oracle change)", () => {
    const result = evaluateLoginAttempt({
      ...BASE_INPUT,
      identity: null,
      passwordLoginDisabled: true
    });

    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("invalid_credentials");
    }
  });
});
