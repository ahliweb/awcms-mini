/**
 * Issue #840 — `POST /api/v1/auth/login` must answer identically whether or
 * not `loginIdentifier` matches a real identity, so an unauthenticated caller
 * cannot enumerate accounts (OWASP ASVS V2.2.1 / WSTG-IDNT-04).
 *
 * Two oracles existed, and only one of them was in the issue:
 *
 * 1. RESPONSE BODY — `locked` answered `"Account is temporarily locked."` and
 *    `password_login_disabled` answered `403 PASSWORD_LOGIN_DISABLED`, both
 *    reachable only once the identity resolved.
 * 2. TIMING — the bigger one, and absent from the issue: an unknown
 *    identifier skipped `verifyPassword` entirely, answering in ~4 ms against
 *    ~80 ms for a known one. One request, no lockout to trip, default config.
 *
 * Both are asserted here, because fixing only (1) would have left a ~19x
 * timing gap that enumerates accounts more cheaply than (1) ever did.
 *
 * Every assertion below is BIDIRECTIONAL: each test pins the response for a
 * KNOWN identifier and for an UNKNOWN one and compares them to each other,
 * rather than to a hardcoded expectation. A test that only asserted "locked
 * returns 401" would still pass if the unknown-identifier path drifted to
 * something else entirely.
 *
 * Skipped entirely unless DATABASE_URL is set — see tests/integration/harness.ts.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { resetRateLimitStoreForTests } from "../../src/lib/security/rate-limit";

const OWNER_LOGIN = "enum-owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const UNKNOWN_LOGIN = "ghost@example.com";
const WRONG_PASSWORD = "definitely-not-the-password";

/**
 * Same env shape `tenant-sso-flow.integration.test.ts` uses to activate Issue
 * #591's gate — `isPasswordLoginDisabledForIdentity` is only consulted when
 * `isSsoRequired(env)` is true, so without this the
 * `password_login_disabled` branch is unreachable.
 */
const FULL_ONLINE_SSO_ENV = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online",
  AUTH_SSO_ENABLED: "true",
  AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
};

type LoginAnswer = {
  status: number;
  code: string;
  message: string;
};

async function bootstrapTenant(tenantCode: string): Promise<{
  tenantId: string;
  ownerIdentityId: string;
}> {
  const setup = await invoke<{
    data: { tenantId: string; ownerIdentityId: string };
  }>(setupInitialize, {
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

  return {
    tenantId: setup.body.data.tenantId,
    ownerIdentityId: setup.body.data.ownerIdentityId
  };
}

/**
 * Resets the volumetric limiter before every attempt: these tests
 * deliberately spend more than `AUTH_LOGIN_RATE_LIMIT_MAX` (default 20)
 * attempts from one source, and a 429 short-circuits before the code under
 * test — it would mask the very difference being asserted by making both
 * sides look identical for the wrong reason.
 */
async function attemptLogin(
  tenantId: string,
  loginIdentifier: string,
  password: string
): Promise<LoginAnswer & { elapsedMs: number }> {
  resetRateLimitStoreForTests();

  const startedAt = performance.now();
  const response = await invoke<{ error: { code: string; message: string } }>(
    authLogin,
    {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": tenantId
      },
      body: { loginIdentifier, password },
      cookies: createCookieJar(),
      locals: {}
    }
  );
  const elapsedMs = performance.now() - startedAt;

  return {
    status: response.status,
    code: response.body.error.code,
    message: response.body.error.message,
    elapsedMs
  };
}

function answerOf(result: LoginAnswer): LoginAnswer {
  return {
    status: result.status,
    code: result.code,
    message: result.message
  };
}

/**
 * Same shape as `tenant-sso-flow.integration.test.ts`'s local helper — this
 * file follows that per-file convention rather than widening the shared
 * harness for one caller.
 */
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)]!;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("login account-enumeration resistance (Issue #840)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetRateLimitStoreForTests();
  });

  test("a locked account answers exactly like an unknown identifier", async () => {
    const { tenantId } = await bootstrapTenant("enum-locked");
    const maxAttempts = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5);

    // Trip the per-identity lockout. This is the whole attack: it needs no
    // password knowledge, only the identifier under test.
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await attemptLogin(tenantId, OWNER_LOGIN, WRONG_PASSWORD);
    }

    // Pin that the account really is locked now, via the audit trail rather
    // than the response — otherwise a regression that never locks the account
    // would make this test pass vacuously by comparing two identical
    // `invalid_credentials` answers.
    const lockedAnswer = await attemptLogin(
      tenantId,
      OWNER_LOGIN,
      WRONG_PASSWORD
    );
    const admin = getAdminSql();
    const reasons = (await admin`
      SELECT attributes ->> 'reason' AS reason
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId} AND action = 'login_failed'
      ORDER BY created_at
    `) as { reason: string }[];
    expect(reasons.at(-1)?.reason).toBe("locked");

    const unknownAnswer = await attemptLogin(
      tenantId,
      UNKNOWN_LOGIN,
      WRONG_PASSWORD
    );

    // The locked account is server-side distinguishable (asserted above) but
    // client-side indistinguishable — that is exactly the property wanted.
    expect(answerOf(lockedAnswer)).toEqual(answerOf(unknownAnswer));
    expect(lockedAnswer.message).not.toContain("locked");
  });

  test("a locked account answers exactly like a known account with a wrong password", async () => {
    const { tenantId } = await bootstrapTenant("enum-locked-vs-wrong");
    const maxAttempts = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5);

    const firstWrongAnswer = await attemptLogin(
      tenantId,
      OWNER_LOGIN,
      WRONG_PASSWORD
    );

    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      await attemptLogin(tenantId, OWNER_LOGIN, WRONG_PASSWORD);
    }

    // Even the CORRECT password answers the same once locked — no "your
    // password was right, but..." signal either.
    const lockedAnswer = await attemptLogin(
      tenantId,
      OWNER_LOGIN,
      OWNER_PASSWORD
    );

    expect(answerOf(lockedAnswer)).toEqual(answerOf(firstWrongAnswer));
  });

  test("an admin-locked identity answers exactly like an unknown identifier", async () => {
    const { tenantId, ownerIdentityId } = await bootstrapTenant("enum-status");
    const admin = getAdminSql();

    // `status = 'locked'` is the other half of the policy's `locked` branch,
    // and unlike the counter-driven lockout it is reachable on attempt #1.
    await admin`
      UPDATE awcms_mini_identities SET status = 'locked'
      WHERE id = ${ownerIdentityId}
    `;

    const lockedAnswer = await attemptLogin(
      tenantId,
      OWNER_LOGIN,
      OWNER_PASSWORD
    );
    const unknownAnswer = await attemptLogin(
      tenantId,
      UNKNOWN_LOGIN,
      OWNER_PASSWORD
    );

    expect(answerOf(lockedAnswer)).toEqual(answerOf(unknownAnswer));
  });

  test("a password-login-disabled identity answers exactly like an unknown identifier", async () => {
    const { tenantId, ownerIdentityId } = await bootstrapTenant("enum-sso");
    const admin = getAdminSql();

    // A second identity that is NOT break-glass: the owner stays break-glass
    // so the policy remains valid (`saveTenantAuthPolicy`'s own rule), and
    // this one is the identity the disabled-password branch fires for.
    const otherPassword = "integration-test-other-password";
    const otherHash = await Bun.password.hash(otherPassword);
    const profileRows = (await admin`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Other User')
      RETURNING id
    `) as { id: string }[];
    const otherRows = (await admin`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profileRows[0]!.id}, 'other@example.com', ${otherHash})
      RETURNING id
    `) as { id: string }[];
    const otherIdentityId = otherRows[0]!.id;
    await admin`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${otherIdentityId})
    `;

    await admin`
      INSERT INTO awcms_mini_tenant_auth_policies
        (tenant_id, password_login_enabled, sso_enabled, break_glass_identity_ids)
      VALUES (${tenantId}, false, true, ${[ownerIdentityId]})
    `;

    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      // Correct password, but password login is disabled for this identity —
      // the only way to reach the `password_login_disabled` branch.
      const disabledAnswer = await attemptLogin(
        tenantId,
        "other@example.com",
        otherPassword
      );
      const unknownAnswer = await attemptLogin(
        tenantId,
        UNKNOWN_LOGIN,
        otherPassword
      );

      // Pin server-side that the branch really fired, so this comparison
      // cannot pass vacuously (e.g. if the policy row were ignored and both
      // sides were plain `invalid_credentials`).
      const reasons = (await admin`
        SELECT attributes ->> 'reason' AS reason
        FROM awcms_mini_audit_events
        WHERE tenant_id = ${tenantId}
          AND action = 'login_failed'
          AND resource_id = ${otherIdentityId}
        ORDER BY created_at
      `) as { reason: string }[];
      expect(reasons.at(-1)?.reason).toBe("password_login_disabled");

      expect(answerOf(disabledAnswer)).toEqual(answerOf(unknownAnswer));
      expect(disabledAnswer.status).toBe(401);
      expect(disabledAnswer.code).toBe("AUTH_INVALID_CREDENTIALS");

      // ...and the break-glass owner can still actually get in, i.e. the
      // collapse hid the reason without disabling the escape hatch.
      const ownerLogin = await invoke<{ data: { token: string } }>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
        cookies: createCookieJar()
      });
      expect(ownerLogin.status).toBe(200);
    });
  });

  test("an inactive tenant still answers 403 for every identifier alike", async () => {
    const { tenantId } = await bootstrapTenant("enum-tenant-off");
    const admin = getAdminSql();

    await admin`
      UPDATE awcms_mini_tenants SET status = 'inactive' WHERE id = ${tenantId}
    `;

    // `tenant_inactive` is deliberately NOT collapsed: it is decided before
    // any identity lookup, so it cannot enumerate. Assert that it stays
    // distinct AND that it is identical for known vs unknown identifiers —
    // the property that makes keeping it safe.
    const knownAnswer = await attemptLogin(
      tenantId,
      OWNER_LOGIN,
      WRONG_PASSWORD
    );
    const unknownAnswer = await attemptLogin(
      tenantId,
      UNKNOWN_LOGIN,
      WRONG_PASSWORD
    );

    expect(answerOf(knownAnswer)).toEqual(answerOf(unknownAnswer));
    expect(knownAnswer.status).toBe(403);
    expect(knownAnswer.code).toBe("ACCESS_DENIED");
  });

  test("an unknown identifier costs the same password-verification work as a known one", async () => {
    const { tenantId } = await bootstrapTenant("enum-timing");

    // Warm up: JIT, the connection pool, and (the point of this test) the
    // memoized dummy hash, whose one-time computation would otherwise land
    // inside the first measured unknown-identifier sample.
    await attemptLogin(tenantId, OWNER_LOGIN, "warmup");
    await attemptLogin(tenantId, "warmup@example.com", "warmup");

    const knownTimes: number[] = [];
    const unknownTimes: number[] = [];

    // Interleaved rather than run in two blocks, so any drift in machine load
    // hits both samples equally instead of biasing whichever ran second.
    for (let round = 0; round < 8; round += 1) {
      knownTimes.push(
        (await attemptLogin(tenantId, OWNER_LOGIN, `wrong-${round}`)).elapsedMs
      );
      unknownTimes.push(
        (
          await attemptLogin(
            tenantId,
            `ghost-${round}@example.com`,
            `wrong-${round}`
          )
        ).elapsedMs
      );
    }

    const knownMedian = median(knownTimes);
    const unknownMedian = median(unknownTimes);

    // Medians, not means: one GC pause or DB hiccup must not decide a
    // security assertion.
    //
    // Threshold rationale — this is a coarse shape check, not a constant-time
    // proof. Measured on this harness: before the fix, ratio 0.052 (4.13 ms
    // unknown vs 80.13 ms known); after, 1.002 (90.46 vs 90.29). 0.5 sits an
    // order of magnitude clear of the broken value while leaving ~2x of
    // headroom under the fixed one, so it fails loudly if the argon2id verify
    // is ever skipped again for unknown identifiers, without flaking on
    // ordinary jitter.
    expect(unknownMedian / knownMedian).toBeGreaterThan(0.5);

    // Guards the assertion above from passing vacuously if BOTH paths somehow
    // became trivially fast (e.g. password verification removed altogether):
    // a real argon2id verify cannot complete in under a millisecond.
    expect(unknownMedian).toBeGreaterThan(1);
    expect(knownMedian).toBeGreaterThan(1);
  }, 120_000);
});
