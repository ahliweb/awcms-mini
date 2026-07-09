import { describe, expect, test } from "bun:test";

import {
  isMfaEnabled,
  isMfaRequired,
  resolveChallengeTtlSec,
  resolveTotpDigits,
  resolveTotpIssuer,
  resolveTotpPeriodSec
} from "../../src/lib/auth/mfa-config";

const FULL_ONLINE_ENV = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online"
} as const;

describe("isMfaEnabled", () => {
  test("false when unset", () => {
    expect(isMfaEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('true only for the literal string "true"', () => {
    expect(
      isMfaEnabled({ AUTH_MFA_ENABLED: "true" } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      isMfaEnabled({ AUTH_MFA_ENABLED: "TRUE" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("isMfaRequired — the shared gate login.ts and every MFA endpoint checks", () => {
  test("false when the full-online gate (#587) is off, even if AUTH_MFA_ENABLED=true", () => {
    expect(
      isMfaRequired({ AUTH_MFA_ENABLED: "true" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("false when AUTH_MFA_ENABLED is not set, even if the full-online gate is on", () => {
    expect(isMfaRequired({ ...FULL_ONLINE_ENV } as NodeJS.ProcessEnv)).toBe(
      false
    );
  });

  test("true only when both the full-online gate and AUTH_MFA_ENABLED agree", () => {
    expect(
      isMfaRequired({
        ...FULL_ONLINE_ENV,
        AUTH_MFA_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe("resolveTotpIssuer", () => {
  test("defaults to AWCMS-Mini when unset", () => {
    expect(resolveTotpIssuer({} as NodeJS.ProcessEnv)).toBe("AWCMS-Mini");
  });

  test("uses a trimmed override", () => {
    expect(
      resolveTotpIssuer({
        AUTH_MFA_TOTP_ISSUER: "  My App  "
      } as NodeJS.ProcessEnv)
    ).toBe("My App");
  });

  test("falls back to the default for an empty/whitespace-only override", () => {
    expect(
      resolveTotpIssuer({ AUTH_MFA_TOTP_ISSUER: "   " } as NodeJS.ProcessEnv)
    ).toBe("AWCMS-Mini");
  });
});

describe("resolveTotpPeriodSec", () => {
  test("defaults to 30", () => {
    expect(resolveTotpPeriodSec({} as NodeJS.ProcessEnv)).toBe(30);
  });

  test("uses a valid positive override", () => {
    expect(
      resolveTotpPeriodSec({
        AUTH_MFA_TOTP_PERIOD_SEC: "60"
      } as NodeJS.ProcessEnv)
    ).toBe(60);
  });

  test("falls back to the default for non-numeric/zero/negative values", () => {
    expect(
      resolveTotpPeriodSec({
        AUTH_MFA_TOTP_PERIOD_SEC: "not-a-number"
      } as NodeJS.ProcessEnv)
    ).toBe(30);
    expect(
      resolveTotpPeriodSec({
        AUTH_MFA_TOTP_PERIOD_SEC: "0"
      } as NodeJS.ProcessEnv)
    ).toBe(30);
  });
});

describe("resolveTotpDigits", () => {
  test("defaults to 6", () => {
    expect(resolveTotpDigits({} as NodeJS.ProcessEnv)).toBe(6);
  });

  test("accepts 8", () => {
    expect(
      resolveTotpDigits({ AUTH_MFA_TOTP_DIGITS: "8" } as NodeJS.ProcessEnv)
    ).toBe(8);
  });

  test("falls back to 6 for any other value", () => {
    expect(
      resolveTotpDigits({ AUTH_MFA_TOTP_DIGITS: "7" } as NodeJS.ProcessEnv)
    ).toBe(6);
    expect(
      resolveTotpDigits({
        AUTH_MFA_TOTP_DIGITS: "not-a-number"
      } as NodeJS.ProcessEnv)
    ).toBe(6);
  });
});

describe("resolveChallengeTtlSec", () => {
  test("defaults to 300", () => {
    expect(resolveChallengeTtlSec({} as NodeJS.ProcessEnv)).toBe(300);
  });

  test("uses a valid positive override", () => {
    expect(
      resolveChallengeTtlSec({
        AUTH_MFA_CHALLENGE_TTL_SEC: "120"
      } as NodeJS.ProcessEnv)
    ).toBe(120);
  });

  test("falls back to the default for non-numeric/zero/negative values", () => {
    expect(
      resolveChallengeTtlSec({
        AUTH_MFA_CHALLENGE_TTL_SEC: "-5"
      } as NodeJS.ProcessEnv)
    ).toBe(300);
  });
});
