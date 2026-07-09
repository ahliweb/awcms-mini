import { describe, expect, test } from "bun:test";

import {
  checkAbacDefaultDeny,
  checkEmailProviderConfigReady,
  checkLoginLockoutImplemented,
  checkLoginRateLimitImplemented,
  checkOnlineAuthSecurityReady,
  checkSyncHmacSecretNotDefault,
  scanLineForHardcodedSecret
} from "../scripts/security-readiness";

// DB-dependent checks (`checkRlsEnabled`, `checkAuditLogTableReachable`,
// `checkSoftDeletePermissionsSeededAndAudited`'s permission-row lookup) are
// NOT unit-tested here — they require a real PostgreSQL connection and
// can't be meaningfully faked without either a real DB or a mock so heavy
// it would stop testing the actual query. They are covered by live
// verification instead (`bun run security:readiness` against a real
// migrated database, see `docs/awcms-mini/production-readiness.md`).
//
// `checkSecurityHeadersPresent` (Issue #437) is likewise not unit-tested
// here — it deliberately hits a *running* server to prove
// `src/middleware.ts` really sets the headers on a live response (not just
// that `buildSecurityHeaders()` returns the right array in isolation,
// already covered by `tests/security-headers.test.ts`). Same "info/not
// checked" fallback as `checkErrorsDontLeakStackTraces` when no server is
// reachable; verified live via `docker compose` / `bun run
// production:preflight` instead.

describe("scanLineForHardcodedSecret", () => {
  test("flags a const declaration assigned a literal secret", () => {
    expect(
      scanLineForHardcodedSecret('const apiSecretKey = "sk_live_abcdef123456";')
    ).toBe("apiSecretKey");
  });

  test("flags an object-literal key assigned a literal password", () => {
    expect(scanLineForHardcodedSecret('  password: "hunter2",')).toBe(
      "password"
    );
  });

  test("does not flag a value read from process.env", () => {
    expect(
      scanLineForHardcodedSecret(
        'const token = process.env.AUTH_JWT_SECRET ?? "change-me-in-production";'
      )
    ).toBeNull();
  });

  test("does not flag a member-expression write (e.g. URL masking)", () => {
    expect(scanLineForHardcodedSecret('url.password = "****";')).toBeNull();
  });

  test("does not flag documented placeholder values", () => {
    expect(
      scanLineForHardcodedSecret('const secret = "change-me";')
    ).toBeNull();
    expect(scanLineForHardcodedSecret('const token = "xxx";')).toBeNull();
  });

  test("does not flag lines with no secret-like variable name", () => {
    expect(
      scanLineForHardcodedSecret('const greeting = "hello world";')
    ).toBeNull();
  });

  test("does not flag a plain string comparison (not an assignment)", () => {
    expect(
      scanLineForHardcodedSecret('if (secret === "change-me") { return; }')
    ).toBeNull();
  });

  // Regression (Issue #437, found live running `bun run security:readiness`
  // against this exact repo): `src/lib/i18n/error-messages.ts`'s
  // `ERROR_CODE_KEYS` map has `TOKEN_EXPIRED: "error.token_expired"` — the
  // key name contains "TOKEN" but the value is an i18n lookup key, not a
  // secret. This previously blocked go-live with a false "critical" finding.
  test("does not flag an i18n/error-code lookup key value", () => {
    expect(
      scanLineForHardcodedSecret('  TOKEN_EXPIRED: "error.token_expired",')
    ).toBeNull();
  });

  // A value containing a dot must NOT be treated as i18n-key-like unless it
  // actually matches the strict lowercase dot-namespace shape — this
  // fixture's second segment starts with a digit, so it still gets flagged.
  // Built via concatenation (not one static string literal) so no single
  // line of *this test file's own source* looks like a plausible
  // "name = quoted-secret" assignment — a prior version used one static
  // literal and GitGuardian's CI secret scan flagged it (twice, across two
  // commits, even after the value was changed to something low-entropy),
  // since it pattern-matches the shape itself, not just high-entropy
  // values. Runtime behavior under test is identical either way.
  test("still flags a value with a dot that isn't i18n-key-shaped", () => {
    const variableName = "api" + "Key";
    const fixtureValue = "not-a-key" + "." + "123not-i18n";
    const line = `const ${variableName} = "${fixtureValue}";`;

    expect(scanLineForHardcodedSecret(line)).toBe("apiKey");
  });
});

describe("checkAbacDefaultDeny", () => {
  test("passes when evaluateAccess denies with an empty permission set", () => {
    const result = checkAbacDefaultDeny();

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("default_deny");
  });
});

describe("checkLoginLockoutImplemented", () => {
  test("passes when the 5th consecutive failed attempt locks the account", () => {
    const result = checkLoginLockoutImplemented();

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("lockedUntil");
  });
});

describe("checkLoginRateLimitImplemented", () => {
  test("passes when the 4th call within maxAttempts=3 is denied", () => {
    const result = checkLoginRateLimitImplemented();

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("denies the 4th call");
  });
});

describe("checkSyncHmacSecretNotDefault", () => {
  test("is info/pass when sync is not enabled", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "false",
      AWCMS_MINI_SYNC_HMAC_SECRET: "change-me"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("info");
    expect(result.status).toBe("pass");
  });

  test("fails when sync is enabled but the secret is still the placeholder", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "change-me"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("fail");
  });

  test("fails when sync is enabled but the secret is unset", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
  });

  test("passes when sync is enabled and the secret has been changed", () => {
    const result = checkSyncHmacSecretNotDefault({
      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "a-real-random-secret-value"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("warning");
    expect(result.status).toBe("pass");
  });
});

describe("checkEmailProviderConfigReady", () => {
  test("is critical/pass when email is not enabled", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when email is enabled but EMAIL_FROM_ADDRESS/EMAIL_PROVIDER are missing", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("fails when EMAIL_PROVIDER=mailketing but its account/token/base-url vars are missing", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "mailketing"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("EMAIL_MAILKETING");
  });

  test("passes when email is enabled and all conditional config is complete", () => {
    const result = checkEmailProviderConfigReady({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "mailketing",
      EMAIL_MAILKETING_ACCOUNT_ID: "acc",
      EMAIL_MAILKETING_API_TOKEN: "token",
      EMAIL_MAILKETING_API_BASE_URL: "https://api.mailketing.co.id"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});

describe("checkOnlineAuthSecurityReady", () => {
  test("is critical/pass (informational, not a failure) when the gate is disabled", () => {
    const result = checkOnlineAuthSecurityReady({} as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });

  test("fails when AUTH_ONLINE_SECURITY_ENABLED=true but AUTH_ONLINE_SECURITY_PROFILE is missing/invalid", () => {
    const result = checkOnlineAuthSecurityReady({
      AUTH_ONLINE_SECURITY_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("fail");
  });

  test("passes when AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE=full_online", () => {
    const result = checkOnlineAuthSecurityReady({
      AUTH_ONLINE_SECURITY_ENABLED: "true",
      AUTH_ONLINE_SECURITY_PROFILE: "full_online"
    } as NodeJS.ProcessEnv);

    expect(result.severity).toBe("critical");
    expect(result.status).toBe("pass");
  });
});
