/**
 * Integration tests for the MFA/TOTP login-challenge flow (Issue #589, epic:
 * full-online auth hardening) across the real route handlers against a real
 * PostgreSQL — enrollment, login-time challenge issuance/verification,
 * disable, and recovery-code regeneration. The pure TOTP math/crypto is
 * already covered by `tests/unit/totp.test.ts`/`mfa-crypto.test.ts`; this
 * file proves the endpoints are wired correctly end to end, mirroring
 * `turnstile-gate.integration.test.ts`'s shape for the #588 feature this
 * epic shares a gate with.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as passwordForgot } from "../../src/pages/api/v1/auth/password/forgot";
import { POST as passwordReset } from "../../src/pages/api/v1/auth/password/reset";
import { GET as mfaStatus } from "../../src/pages/api/v1/auth/mfa/status";
import { POST as enrollStart } from "../../src/pages/api/v1/auth/mfa/totp/enroll/start";
import { POST as enrollVerify } from "../../src/pages/api/v1/auth/mfa/totp/enroll/verify";
import { POST as mfaVerify } from "../../src/pages/api/v1/auth/mfa/totp/verify";
import { POST as mfaDisable } from "../../src/pages/api/v1/auth/mfa/totp/disable";
import { POST as recoveryCodesRegenerate } from "../../src/pages/api/v1/auth/mfa/recovery-codes/regenerate";
import { base32Decode, generateTotpCode } from "../../src/lib/auth/totp";
import { resetRateLimitStoreForTests } from "../../src/lib/security/rate-limit";
import { getAdminSql } from "./harness";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const VALID_MFA_KEY_BASE64 = Buffer.alloc(32, 11).toString("base64");

const FULL_ONLINE_MFA_ENV: Record<string, string> = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online",
  AUTH_MFA_ENABLED: "true",
  AUTH_MFA_SECRET_ENCRYPTION_KEY: VALID_MFA_KEY_BASE64
};

type ErrorEnvelope = {
  error: { code: string; details?: { mfaChallengeToken?: string } };
};

/** Same pattern `turnstile-gate.integration.test.ts` uses. */
async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function bootstrapTenant(tenantCode = "acme") {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: `Tenant ${tenantCode}`,
      tenantCode,
      officeCode: "hq",
      officeName: "Head Office",
      ownerLoginIdentifier: OWNER_LOGIN,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  return { tenantId: setup.body.data.tenantId };
}

async function loginAndGetToken(tenantId: string): Promise<string> {
  const result = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(result.status).toBe(200);
  return result.body.data.token;
}

function totpCodeFor(secretBase32: string, at: number = Date.now()): string {
  return generateTotpCode(base32Decode(secretBase32), at, {
    periodSec: 30,
    digits: 6
  });
}

/** Enrolls and activates TOTP MFA for the already-logged-in owner, returning the base32 secret (to compute future codes) and the one-time recovery codes. */
async function enrollMfa(
  tenantId: string,
  sessionToken: string
): Promise<{ secretBase32: string; recoveryCodes: string[] }> {
  const start = await invoke<{ data: { secret: string; otpauthUri: string } }>(
    enrollStart,
    {
      method: "POST",
      path: "/api/v1/auth/mfa/totp/enroll/start",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": tenantId,
        authorization: `Bearer ${sessionToken}`
      }
    }
  );
  expect(start.status).toBe(200);

  const secretBase32 = start.body.data.secret;
  const code = totpCodeFor(secretBase32);

  const verify = await invoke<{
    data: { activated: boolean; recoveryCodes: string[] };
  }>(enrollVerify, {
    method: "POST",
    path: "/api/v1/auth/mfa/totp/enroll/verify",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId,
      authorization: `Bearer ${sessionToken}`
    },
    body: { code }
  });
  expect(verify.status).toBe(200);
  expect(verify.body.data.activated).toBe(true);

  return { secretBase32, recoveryCodes: verify.body.data.recoveryCodes };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("MFA/TOTP login-challenge flow (Issue #589)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetRateLimitStoreForTests();
  });

  test("disabled mode (default): MFA endpoints report disabled without touching the DB", async () => {
    const owner = await bootstrapTenant();
    const token = await loginAndGetToken(owner.tenantId);

    const status = await invoke<ErrorEnvelope>(mfaStatus, {
      method: "GET",
      path: "/api/v1/auth/mfa/status",
      headers: {
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${token}`
      }
    });
    expect(status.status).toBe(403);
    expect(status.body.error.code).toBe("MFA_DISABLED");
  });

  test("gate enabled but identity never enrolled: login still succeeds normally (opt-in per identity)", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const token = await loginAndGetToken(owner.tenantId);
      expect(typeof token).toBe("string");
    });
  });

  test("enroll/start rejects an invalid confirmation code", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const token = await loginAndGetToken(owner.tenantId);

      const start = await invoke<{ data: { secret: string } }>(enrollStart, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/enroll/start",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${token}`
        }
      });
      expect(start.status).toBe(200);

      const verify = await invoke<ErrorEnvelope>(enrollVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/enroll/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${token}`
        },
        body: { code: "000000" }
      });
      expect(verify.status).toBe(400);
      expect(verify.body.error.code).toBe("MFA_INVALID_CODE");
    });
  });

  test("full enroll -> login challenge -> verify -> session flow", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const initialToken = await loginAndGetToken(owner.tenantId);

      const statusBefore = await invoke<{ data: { enabled: boolean } }>(
        mfaStatus,
        {
          method: "GET",
          path: "/api/v1/auth/mfa/status",
          headers: {
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${initialToken}`
          }
        }
      );
      expect(statusBefore.body.data.enabled).toBe(false);

      const { secretBase32, recoveryCodes } = await enrollMfa(
        owner.tenantId,
        initialToken
      );
      expect(recoveryCodes).toHaveLength(10);

      const statusAfter = await invoke<{
        data: { enabled: boolean; factorType?: string };
      }>(mfaStatus, {
        method: "GET",
        path: "/api/v1/auth/mfa/status",
        headers: {
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${initialToken}`
        }
      });
      expect(statusAfter.body.data.enabled).toBe(true);
      expect(statusAfter.body.data.factorType).toBe("totp");

      // Re-enrolling while a factor is already active must be rejected —
      // an authenticated attacker/hijacked session can't silently replace a
      // live factor's secret.
      const restart = await invoke<ErrorEnvelope>(enrollStart, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/enroll/start",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${initialToken}`
        }
      });
      expect(restart.status).toBe(409);
      expect(restart.body.error.code).toBe("MFA_ALREADY_ACTIVE");

      // Next login must stop at a challenge, not a session — even with the
      // correct password.
      const loginAttempt = await invoke<ErrorEnvelope>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
        cookies: createCookieJar()
      });
      expect(loginAttempt.status).toBe(401);
      expect(loginAttempt.body.error.code).toBe("MFA_REQUIRED");
      const challengeToken = loginAttempt.body.error.details?.mfaChallengeToken;
      expect(typeof challengeToken).toBe("string");

      // Wrong code: challenge stays open, no session created.
      const wrongCode = await invoke<ErrorEnvelope>(mfaVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { mfaChallengeToken: challengeToken, code: "000000" }
      });
      expect(wrongCode.status).toBe(401);
      expect(wrongCode.body.error.code).toBe("MFA_CHALLENGE_INVALID");

      // Correct code completes the challenge and creates a real session.
      // One period later than enrollment's own confirmation code (replay
      // prevention correctly rejects reusing the exact same time step —
      // see `last_used_step` — so this must be a genuinely later step).
      const rightCode = totpCodeFor(secretBase32, Date.now() + 30_000);
      const completed = await invoke<{ data: { token: string } }>(mfaVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { mfaChallengeToken: challengeToken, code: rightCode }
      });
      expect(completed.status).toBe(200);
      expect(typeof completed.body.data.token).toBe("string");

      // The same challenge token can't be replayed after being consumed.
      const replay = await invoke<ErrorEnvelope>(mfaVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { mfaChallengeToken: challengeToken, code: rightCode }
      });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe("MFA_CHALLENGE_INVALID");
    });
  });

  test("recovery code completes a challenge and is single-use", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const initialToken = await loginAndGetToken(owner.tenantId);
      const { recoveryCodes } = await enrollMfa(owner.tenantId, initialToken);

      const loginAttempt = await invoke<ErrorEnvelope>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
        cookies: createCookieJar()
      });
      const challengeToken = loginAttempt.body.error.details?.mfaChallengeToken;

      const firstUse = await invoke<{ data: { token: string } }>(mfaVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: {
          mfaChallengeToken: challengeToken,
          recoveryCode: recoveryCodes[0]
        }
      });
      expect(firstUse.status).toBe(200);

      // A second login challenge + the SAME recovery code must fail (single-use).
      const secondLoginAttempt = await invoke<ErrorEnvelope>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
        cookies: createCookieJar()
      });
      const secondChallengeToken =
        secondLoginAttempt.body.error.details?.mfaChallengeToken;

      const reusedCode = await invoke<ErrorEnvelope>(mfaVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: {
          mfaChallengeToken: secondChallengeToken,
          recoveryCode: recoveryCodes[0]
        }
      });
      expect(reusedCode.status).toBe(401);
      expect(reusedCode.body.error.code).toBe("MFA_CHALLENGE_INVALID");
    });
  });

  test("disable: removes the factor, login goes back to creating a session directly", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const initialToken = await loginAndGetToken(owner.tenantId);
      await enrollMfa(owner.tenantId, initialToken);

      const disable = await invoke<{ data: { disabled: boolean } }>(
        mfaDisable,
        {
          method: "POST",
          path: "/api/v1/auth/mfa/totp/disable",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${initialToken}`
          }
        }
      );
      expect(disable.status).toBe(200);
      expect(disable.body.data.disabled).toBe(true);

      // Disabling again (nothing active) is a conflict, not a silent no-op success.
      const disableAgain = await invoke<ErrorEnvelope>(mfaDisable, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/disable",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${initialToken}`
        }
      });
      expect(disableAgain.status).toBe(409);
      expect(disableAgain.body.error.code).toBe("MFA_NOT_ACTIVE");

      const loginAfterDisable = await invoke<{ data: { token: string } }>(
        authLogin,
        {
          method: "POST",
          path: "/api/v1/auth/login",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId
          },
          body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
          cookies: createCookieJar()
        }
      );
      expect(loginAfterDisable.status).toBe(200);
      expect(typeof loginAfterDisable.body.data.token).toBe("string");
    });
  });

  test("recovery-codes/regenerate invalidates the previous set and issues a fresh one", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const initialToken = await loginAndGetToken(owner.tenantId);
      const { recoveryCodes: originalCodes } = await enrollMfa(
        owner.tenantId,
        initialToken
      );

      const regenerate = await invoke<{ data: { recoveryCodes: string[] } }>(
        recoveryCodesRegenerate,
        {
          method: "POST",
          path: "/api/v1/auth/mfa/recovery-codes/regenerate",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${initialToken}`
          }
        }
      );
      expect(regenerate.status).toBe(200);
      const freshCodes = regenerate.body.data.recoveryCodes;
      expect(freshCodes).toHaveLength(10);
      expect(freshCodes).not.toEqual(originalCodes);

      const loginAttempt = await invoke<ErrorEnvelope>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
        cookies: createCookieJar()
      });
      const challengeToken = loginAttempt.body.error.details?.mfaChallengeToken;

      // An old (pre-regeneration) recovery code must no longer work.
      const oldCodeAttempt = await invoke<ErrorEnvelope>(mfaVerify, {
        method: "POST",
        path: "/api/v1/auth/mfa/totp/verify",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: {
          mfaChallengeToken: challengeToken,
          recoveryCode: originalCodes[0]
        }
      });
      expect(oldCodeAttempt.status).toBe(401);

      // A fresh code does.
      const freshCodeAttempt = await invoke<{ data: { token: string } }>(
        mfaVerify,
        {
          method: "POST",
          path: "/api/v1/auth/mfa/totp/verify",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId
          },
          body: {
            mfaChallengeToken: challengeToken,
            recoveryCode: freshCodes[0]
          }
        }
      );
      expect(freshCodeAttempt.status).toBe(200);
    });
  });

  test("password reset does not disable MFA (no bypass)", async () => {
    const owner = await bootstrapTenant();
    const NEW_PASSWORD = "New-Owner-Password-456";

    await withEnvOverride(FULL_ONLINE_MFA_ENV, async () => {
      const initialToken = await loginAndGetToken(owner.tenantId);
      await enrollMfa(owner.tenantId, initialToken);

      const forgot = await invoke(passwordForgot, {
        method: "POST",
        path: "/api/v1/auth/password/forgot",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN }
      });
      expect(forgot.status).toBe(200);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT variables ->> 'resetUrl' AS reset_url
        FROM awcms_mini_email_messages
        WHERE tenant_id = ${owner.tenantId} AND category = 'auth.password_reset'
        ORDER BY created_at DESC
        LIMIT 1
      `) as { reset_url: string }[];
      const rawToken = new URL(rows[0]!.reset_url).searchParams.get("token");
      expect(typeof rawToken).toBe("string");

      const reset = await invoke(passwordReset, {
        method: "POST",
        path: "/api/v1/auth/password/reset",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { token: rawToken, newPassword: NEW_PASSWORD }
      });
      expect(reset.status).toBe(200);

      // The MFA factor row must survive a completed password reset intact.
      const factorRows = (await admin`
        SELECT status FROM awcms_mini_identity_mfa_factors
        WHERE tenant_id = ${owner.tenantId} AND status = 'active'
      `) as { status: string }[];
      expect(factorRows).toHaveLength(1);

      // Logging in with the NEW password must still stop at an MFA
      // challenge, not a session — password reset is not an MFA bypass.
      const loginAttempt = await invoke<ErrorEnvelope>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: NEW_PASSWORD },
        cookies: createCookieJar()
      });
      expect(loginAttempt.status).toBe(401);
      expect(loginAttempt.body.error.code).toBe("MFA_REQUIRED");
    });
  });
});
