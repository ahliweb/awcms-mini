import { describe, expect, test } from "bun:test";

import {
  checkAbacDefaultDeny,
  checkLoginLockoutImplemented,
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
