/**
 * Issue #821 — `POST /api/v1/auth/login` imported `recordAuditEvent` but only
 * ever called it for `mfa_challenge_issued`: neither a successful nor a failed
 * password sign-in produced an audit row, leaving zero trail of
 * brute-force/credential-stuffing against the repo's most attacked endpoint
 * (doc 01 §"Base-ready boundary" requires "Audit log high-risk tersedia";
 * skill `awcms-mini-audit-log` lists login as the first high-risk action).
 *
 * These tests assert the row COUNT, not just presence — a double-write is as
 * much a defect as a missing write for an audit trail people reason about by
 * counting attempts.
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

const OWNER_LOGIN = "audit-owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const SOURCE_IP = "203.0.113.41";
const USER_AGENT = "AWCMS-Mini-Integration/1.0";
const CORRELATION_ID = "corr-login-audit-1";

type AuditRow = {
  action: string;
  resource_id: string | null;
  severity: string;
  message: string;
  attributes: Record<string, unknown> | null;
  correlation_id: string | null;
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

async function attemptLogin(
  tenantId: string,
  body: { loginIdentifier: string; password: string }
): Promise<number> {
  const response = await invoke(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId,
      "x-forwarded-for": SOURCE_IP,
      "user-agent": USER_AGENT
    },
    body,
    cookies: createCookieJar(),
    locals: { correlationId: CORRELATION_ID }
  });

  return response.status;
}

/** Read back with the admin (RLS-bypassing) role — the assertion is about what
 * was persisted, not about who may read it. */
async function readAuditRows(
  tenantId: string,
  action: string
): Promise<AuditRow[]> {
  const sql = getAdminSql();

  return (await sql`
    SELECT action, resource_id, severity, message, attributes, correlation_id
    FROM awcms_mini_audit_events
    WHERE tenant_id = ${tenantId} AND action = ${action}
    ORDER BY created_at
  `) as AuditRow[];
}

/**
 * Asserts the "exactly one row" expectation these tests exist to enforce, and
 * narrows the result so each caller doesn't repeat a null check that would
 * only ever fire when that assertion has already failed.
 */
async function readSingleAuditRow(
  tenantId: string,
  action: string
): Promise<AuditRow> {
  const rows = await readAuditRows(tenantId, action);
  expect(rows).toHaveLength(1);

  const row = rows[0];

  if (!row) {
    throw new Error(`Expected exactly one "${action}" audit row.`);
  }

  return row;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("login audit trail (Issue #821)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    // The bootstrap login inside setup + several attempts per test share one
    // source IP; without this the volumetric limiter (default 20/60s) could
    // turn a later attempt into a 429 that never reaches the audit code.
    resetRateLimitStoreForTests();
  });

  test("a successful password login writes exactly one login_succeeded row", async () => {
    const { tenantId, ownerIdentityId } = await bootstrapTenant("audit-ok");

    expect(
      await attemptLogin(tenantId, {
        loginIdentifier: OWNER_LOGIN,
        password: OWNER_PASSWORD
      })
    ).toBe(200);

    const row = await readSingleAuditRow(tenantId, "login_succeeded");
    expect(row.resource_id).toBe(ownerIdentityId);
    expect(row.severity).toBe("info");
    expect(row.correlation_id).toBe(CORRELATION_ID);
    expect(row.attributes?.method).toBe("password");
    expect(row.attributes?.userAgent).toBe(USER_AGENT);

    // Source attribution is present but pseudonymous: correlatable across
    // rows, never the raw address (see lib/security/client-fingerprint.ts).
    expect(row.attributes?.ipHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(row.attributes?.ipHash).not.toContain(SOURCE_IP);

    // No failure row was written alongside the success.
    expect(await readAuditRows(tenantId, "login_failed")).toHaveLength(0);
  });

  test("a wrong password writes exactly one login_failed row carrying the reason", async () => {
    const { tenantId, ownerIdentityId } = await bootstrapTenant("audit-bad-pw");

    expect(
      await attemptLogin(tenantId, {
        loginIdentifier: OWNER_LOGIN,
        password: "definitely-not-the-password"
      })
    ).toBe(401);

    const row = await readSingleAuditRow(tenantId, "login_failed");
    expect(row.severity).toBe("warning");
    expect(row.correlation_id).toBe(CORRELATION_ID);
    expect(row.attributes?.reason).toBe("invalid_credentials");
    expect(row.attributes?.method).toBe("password");
    expect(row.resource_id).toBe(ownerIdentityId);

    expect(await readAuditRows(tenantId, "login_succeeded")).toHaveLength(0);
  });

  test("a locked account writes login_failed with the locked reason", async () => {
    const { tenantId } = await bootstrapTenant("audit-locked");
    const maxAttempts = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5);

    // Trip the per-identity lockout, then attempt once more: only that final
    // attempt can produce the `locked` reason.
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      expect(
        await attemptLogin(tenantId, {
          loginIdentifier: OWNER_LOGIN,
          password: "wrong-password"
        })
      ).toBe(401);
    }

    expect(
      await attemptLogin(tenantId, {
        loginIdentifier: OWNER_LOGIN,
        password: OWNER_PASSWORD
      })
    ).toBe(401);

    const reasons = (await readAuditRows(tenantId, "login_failed")).map(
      (row) => row.attributes?.reason
    );

    // One row per attempt — no attempt is silently untraced, and the lockout
    // that follows them is distinguishable from the attempts that caused it.
    expect(reasons).toHaveLength(maxAttempts + 1);
    expect(reasons.slice(0, maxAttempts)).toEqual(
      Array.from({ length: maxAttempts }, () => "invalid_credentials")
    );
    expect(reasons.at(-1)).toBe("locked");
  });

  test("an unknown account is audited without revealing that it is unknown", async () => {
    const { tenantId } = await bootstrapTenant("audit-unknown");

    expect(
      await attemptLogin(tenantId, {
        loginIdentifier: "ghost@example.com",
        password: "whatever"
      })
    ).toBe(401);

    const row = await readSingleAuditRow(tenantId, "login_failed");

    // Same reason a *real* account with a wrong password gets (asserted
    // above) — the reason alone can never be used to enumerate accounts.
    expect(row.attributes?.reason).toBe("invalid_credentials");

    // The attacker-supplied identifier (usually an email — PII that no
    // redaction key would catch under this name) is never persisted.
    expect(JSON.stringify(row)).not.toContain("ghost@example.com");
  });

  test("no login audit row ever contains the submitted password", async () => {
    const { tenantId } = await bootstrapTenant("audit-no-secret");

    await attemptLogin(tenantId, {
      loginIdentifier: OWNER_LOGIN,
      password: OWNER_PASSWORD
    });
    await attemptLogin(tenantId, {
      loginIdentifier: OWNER_LOGIN,
      password: "wrong-password"
    });

    const sql = getAdminSql();
    const rows = (await sql`
      SELECT attributes, message FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId}
    `) as { attributes: unknown; message: string }[];

    expect(rows.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(OWNER_PASSWORD);
    expect(serialized).not.toContain("wrong-password");
    // Neither the plaintext nor the argon2 hash of it.
    expect(serialized).not.toContain("$argon2");
  });

  test("login_failed survives a rollback of the login transaction", async () => {
    const { tenantId } = await bootstrapTenant("audit-rollback");
    const admin = getAdminSql();

    // Force the login transaction to throw *after* it has begun writing, the
    // one case the in-transaction audit write cannot survive on its own.
    // A trigger on the session INSERT is the least invasive way to reproduce
    // it against the real schema (the success path's own audit row is written
    // after this INSERT, so it is rolled back too — exactly the scenario).
    await admin`
      CREATE OR REPLACE FUNCTION awcms_mini_test_fail_session_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure';
      END;
      $$ LANGUAGE plpgsql
    `;
    await admin`
      CREATE TRIGGER awcms_mini_test_fail_session_insert_trigger
      BEFORE INSERT ON awcms_mini_sessions
      FOR EACH ROW EXECUTE FUNCTION awcms_mini_test_fail_session_insert()
    `;

    try {
      let threw = false;

      try {
        await attemptLogin(tenantId, {
          loginIdentifier: OWNER_LOGIN,
          password: OWNER_PASSWORD
        });
      } catch (error) {
        // The original error is rethrown untouched, never swallowed by the
        // audit recovery.
        threw = true;
        expect(error).toBeInstanceOf(Error);
      }

      expect(threw).toBe(true);

      // The rolled-back transaction took its own audit row with it...
      expect(await readAuditRows(tenantId, "login_succeeded")).toHaveLength(0);

      // ...but the failure is still on the record, written out-of-band.
      const row = await readSingleAuditRow(tenantId, "login_failed");
      expect(row.attributes?.reason).toBe("internal_error");
      expect(row.severity).toBe("warning");
    } finally {
      await admin`
        DROP TRIGGER IF EXISTS awcms_mini_test_fail_session_insert_trigger
        ON awcms_mini_sessions
      `;
      await admin`
        DROP FUNCTION IF EXISTS awcms_mini_test_fail_session_insert()
      `;
    }
  });
});
