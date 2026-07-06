import { describe, expect, test } from "bun:test";

import {
  computeLockedUntil,
  evaluateLoginAttempt,
  isAccountLocked,
  shouldLockAccount
} from "../src/modules/identity-access/domain/login-policy";
import { extractBearerToken } from "../src/modules/identity-access/application/session-lookup";
import { hashPassword, verifyPassword } from "../src/lib/auth/password";
import {
  generateSessionToken,
  hashSessionToken
} from "../src/lib/auth/session-token";
import { assertUuid } from "../src/lib/database/tenant-context";
import {
  resolveSsrContext,
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../src/lib/auth/ssr-session";
import {
  generateResetToken,
  hashResetToken
} from "../src/lib/auth/password-reset-token";
import { evaluatePasswordResetToken } from "../src/modules/identity-access/domain/password-reset-policy";
import {
  validateForgotIdentifierInput,
  validateCompleteResetInput
} from "../src/modules/identity-access/domain/password-reset-validation";

const NOW = new Date("2026-07-05T00:00:00.000Z");

describe("login lockout primitives", () => {
  test("isAccountLocked compares lockedUntil against now", () => {
    expect(isAccountLocked(null, NOW)).toBe(false);
    expect(isAccountLocked(new Date(NOW.getTime() - 1000), NOW)).toBe(false);
    expect(isAccountLocked(new Date(NOW.getTime() + 1000), NOW)).toBe(true);
  });

  test("shouldLockAccount triggers at the configured threshold", () => {
    expect(shouldLockAccount(4, 5)).toBe(false);
    expect(shouldLockAccount(5, 5)).toBe(true);
    expect(shouldLockAccount(6, 5)).toBe(true);
  });

  test("computeLockedUntil adds the lockout window in minutes", () => {
    expect(computeLockedUntil(NOW, 15).toISOString()).toBe(
      "2026-07-05T00:15:00.000Z"
    );
  });
});

describe("evaluateLoginAttempt", () => {
  const baseInput = {
    now: NOW,
    tenantStatus: "active",
    identity: {
      status: "active" as const,
      failedLoginCount: 0,
      lockedUntil: null
    },
    tenantUserStatus: "active" as const,
    passwordMatches: true,
    maxFailedAttempts: 5,
    lockoutMinutes: 15
  };

  test("allows a valid login", () => {
    expect(evaluateLoginAttempt(baseInput)).toEqual({ outcome: "allow" });
  });

  test("denies when the tenant is not active, before checking credentials", () => {
    expect(
      evaluateLoginAttempt({
        ...baseInput,
        tenantStatus: "inactive",
        passwordMatches: false
      })
    ).toEqual({ outcome: "deny", reason: "tenant_inactive" });
  });

  test("denies with a generic reason when the identity does not exist", () => {
    expect(
      evaluateLoginAttempt({
        ...baseInput,
        identity: null,
        passwordMatches: false
      })
    ).toEqual({ outcome: "deny", reason: "invalid_credentials" });
  });

  test("denies and increments the failed counter on wrong password", () => {
    expect(
      evaluateLoginAttempt({ ...baseInput, passwordMatches: false })
    ).toEqual({
      outcome: "deny",
      reason: "invalid_credentials",
      failedLoginCount: 1,
      lockedUntil: null
    });
  });

  test("locks the account once failed attempts reach the threshold", () => {
    const result = evaluateLoginAttempt({
      ...baseInput,
      identity: { ...baseInput.identity, failedLoginCount: 4 },
      passwordMatches: false
    });

    expect(result.outcome).toBe("deny");
    expect(result).toMatchObject({
      reason: "invalid_credentials",
      failedLoginCount: 5
    });
    expect(
      (result as { lockedUntil: Date | null }).lockedUntil?.toISOString()
    ).toBe("2026-07-05T00:15:00.000Z");
  });

  test("denies an already-locked identity without touching the failed counter", () => {
    expect(
      evaluateLoginAttempt({
        ...baseInput,
        identity: {
          status: "active",
          failedLoginCount: 5,
          lockedUntil: new Date(NOW.getTime() + 60_000)
        }
      })
    ).toEqual({ outcome: "deny", reason: "locked" });
  });

  test("denies identity with status locked even if lockedUntil has passed", () => {
    expect(
      evaluateLoginAttempt({
        ...baseInput,
        identity: { status: "locked", failedLoginCount: 5, lockedUntil: null }
      })
    ).toEqual({ outcome: "deny", reason: "locked" });
  });

  test("denies an inactive tenant user with a generic reason", () => {
    expect(
      evaluateLoginAttempt({ ...baseInput, tenantUserStatus: "inactive" })
    ).toEqual({
      outcome: "deny",
      reason: "invalid_credentials",
      failedLoginCount: 1,
      lockedUntil: null
    });
  });

  test("denies a missing tenant user membership with a generic reason", () => {
    expect(
      evaluateLoginAttempt({ ...baseInput, tenantUserStatus: null })
    ).toEqual({
      outcome: "deny",
      reason: "invalid_credentials",
      failedLoginCount: 1,
      lockedUntil: null
    });
  });
});

describe("bearer token extraction", () => {
  test("extracts the token from a well-formed Authorization header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer   abc123  ")).toBe("abc123");
  });

  test("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abc123")).toBeNull();
  });
});

describe("password hashing", () => {
  test("verifies a correct password and rejects an incorrect one", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash).not.toContain("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", hash)
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });
});

describe("session token", () => {
  test("generates a high-entropy token and hashes it deterministically", () => {
    const tokenA = generateSessionToken();
    const tokenB = generateSessionToken();

    expect(tokenA).not.toBe(tokenB);
    expect(tokenA.length).toBeGreaterThanOrEqual(32);
    expect(hashSessionToken(tokenA)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashSessionToken(tokenA)).toBe(hashSessionToken(tokenA));
    expect(hashSessionToken(tokenA)).not.toBe(hashSessionToken(tokenB));
  });
});

describe("assertUuid", () => {
  test("passes through a valid UUID", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";

    expect(assertUuid(uuid)).toBe(uuid);
  });

  test("throws for a non-UUID value, guarding SET LOCAL string interpolation", () => {
    expect(() => assertUuid("'; DROP TABLE awcms_mini_tenants; --")).toThrow(
      "Expected a UUID"
    );
  });
});

describe("resolveSsrContext (Issue 8.1 — SSR admin shell auth)", () => {
  function fakeCookies(values: Record<string, string>) {
    return {
      get: (name: string) =>
        name in values ? { value: values[name] } : undefined
    } as unknown as Parameters<typeof resolveSsrContext>[0];
  }

  test("returns null without touching the database when both cookies are missing", async () => {
    await expect(
      resolveSsrContext(fakeCookies({}), new Date())
    ).resolves.toBeNull();
  });

  test("returns null when only the tenant cookie is present", async () => {
    const cookies = fakeCookies({
      [TENANT_COOKIE_NAME]: "11111111-1111-1111-1111-111111111111"
    });

    await expect(resolveSsrContext(cookies, new Date())).resolves.toBeNull();
  });

  test("returns null when only the session cookie is present", async () => {
    const cookies = fakeCookies({ [SESSION_COOKIE_NAME]: "some-token" });

    await expect(resolveSsrContext(cookies, new Date())).resolves.toBeNull();
  });
});

describe("password reset token generation/hashing (Issue #496)", () => {
  test("generateResetToken produces a high-entropy, unique token", () => {
    const a = generateResetToken();
    const b = generateResetToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });

  test("hashResetToken is deterministic and sha256-prefixed", () => {
    const token = "fixed-test-token";
    expect(hashResetToken(token)).toBe(hashResetToken(token));
    expect(hashResetToken(token)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("evaluatePasswordResetToken (Issue #496)", () => {
  const now = new Date("2026-07-05T00:00:00.000Z");

  test("not_found when no row exists", () => {
    expect(evaluatePasswordResetToken(null, now)).toEqual({
      outcome: "invalid",
      reason: "not_found"
    });
  });

  test("already_used takes priority when usedAt is set, even if also expired", () => {
    const result = evaluatePasswordResetToken(
      {
        expiresAt: new Date(now.getTime() - 1000),
        usedAt: new Date(now.getTime() - 500)
      },
      now
    );
    expect(result).toEqual({ outcome: "invalid", reason: "already_used" });
  });

  test("expired when expiresAt is in the past and never used", () => {
    const result = evaluatePasswordResetToken(
      { expiresAt: new Date(now.getTime() - 1000), usedAt: null },
      now
    );
    expect(result).toEqual({ outcome: "invalid", reason: "expired" });
  });

  test("valid when unused and not yet expired", () => {
    const result = evaluatePasswordResetToken(
      { expiresAt: new Date(now.getTime() + 1000), usedAt: null },
      now
    );
    expect(result).toEqual({ outcome: "valid" });
  });
});

describe("validateForgotIdentifierInput (Issue #496)", () => {
  test("accepts a non-empty loginIdentifier", () => {
    const result = validateForgotIdentifierInput({
      loginIdentifier: "user@example.com"
    });
    expect(result.valid).toBe(true);
  });

  test("rejects a missing loginIdentifier", () => {
    expect(validateForgotIdentifierInput({}).valid).toBe(false);
  });

  test("rejects an empty-string loginIdentifier", () => {
    expect(
      validateForgotIdentifierInput({ loginIdentifier: "   " }).valid
    ).toBe(false);
  });
});

describe("validateCompleteResetInput (Issue #496)", () => {
  test("accepts a valid token and password meeting the minimum length", () => {
    const result = validateCompleteResetInput({
      token: "some-raw-token",
      newPassword: "a-strong-password"
    });
    expect(result.valid).toBe(true);
  });

  test("rejects a missing token", () => {
    const result = validateCompleteResetInput({
      newPassword: "a-strong-password"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.field === "token")).toBe(true);
    }
  });

  test("rejects a newPassword shorter than the minimum length", () => {
    const result = validateCompleteResetInput({
      token: "some-raw-token",
      newPassword: "short"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.field === "newPassword")).toBe(
        true
      );
    }
  });
});
