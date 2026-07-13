/**
 * Integration tests proving SoD conflict enforcement is wired at the REAL
 * universal authorization chokepoint (`authorizeInTransaction`, Issue
 * #746) — hitting a REAL guarded endpoint
 * (`POST /api/v1/data-lifecycle/legal-holds/{id}/release`) that this issue
 * did NOT modify, not just unit-testing the pure `detectSoDConflicts`
 * function in isolation. Also covers the scheduled expiry job against the
 * REAL least-privilege `awcms_mini_worker` role
 * (`provisionWorkerRole()`) and the resulting re-authorization once an
 * assignment has expired.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createLegalHold } from "../../src/pages/api/v1/data-lifecycle/legal-holds";
import { POST as releaseLegalHold } from "../../src/pages/api/v1/data-lifecycle/legal-holds/[id]/release";
import { POST as createAssignment } from "../../src/pages/api/v1/identity/business-scope/assignments/index";
import { runBusinessScopeExpiry } from "../../src/modules/identity-access/application/business-scope-expiry-job";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
  officeId: string;
};

async function bootstrap(): Promise<Bootstrap> {
  const tenantCode = "acme";
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];
  const officeRows = (await admin`
    SELECT id FROM awcms_mini_offices WHERE tenant_id = ${setup.body.data.tenantId}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id,
    officeId: officeRows[0]!.id
  };
}

function authHeaders(
  owner: Bootstrap,
  idempotencyKey: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    "idempotency-key": idempotencyKey
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("business-scope SoD chokepoint + expiry worker (Issue #746)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("real chokepoint: owner (who holds legal_hold.release via RBAC AND legal_hold.create via an active business-scope assignment) is DENIED releasing a legal hold — SOD_CONFLICT, no approved exception", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    const hold = await invoke<{ data: { legalHold: { id: string } } }>(
      createLegalHold,
      {
        method: "POST",
        path: "/api/v1/data-lifecycle/legal-holds",
        headers: authHeaders(owner, "hold-create-1"),
        body: {
          descriptorKey: null,
          scopeDescription: "Tenant-wide hold for chokepoint test.",
          reason: "Testing SoD chokepoint enforcement end-to-end.",
          authorityReference: "TEST-REF-1"
        }
      }
    );
    expect(hold.status).toBe(200);

    // A narrow role granting ONLY legal_hold.create, assigned to the OWNER
    // themselves via a business-scope assignment — the owner already holds
    // legal_hold.release via their ordinary RBAC "owner" role (which the
    // setup wizard grants every catalog permission).
    const createPerm = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold' AND action = 'create'
    `) as { id: string }[];
    const narrowRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name) VALUES (${owner.tenantId}, 'hold_creator', 'Hold Creator') RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id) VALUES (${owner.tenantId}, ${narrowRole[0]!.id}, ${createPerm[0]!.id})
    `;

    const assignment = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "assign-1"),
      body: {
        tenantUserId: owner.tenantUserId,
        roleId: narrowRole[0]!.id,
        scopeType: "office",
        scopeId: owner.officeId
      }
    });
    // Self-grant would normally be denied — but here we need the OWNER
    // themselves to hold the conflicting fact, so seed the assignment
    // directly (bypassing the self-grant guard, which is a distinct,
    // already-tested rule) rather than via the API.
    if (assignment.status !== 200) {
      await admin`
        INSERT INTO awcms_mini_business_scope_assignments
          (tenant_id, tenant_user_id, role_id, scope_type, scope_id, granted_by_tenant_user_id, status)
        VALUES (${owner.tenantId}, ${owner.tenantUserId}, ${narrowRole[0]!.id}, 'office', ${owner.officeId}, ${owner.tenantUserId}, 'active')
      `;
    }

    const releaseAttempt = await invoke(releaseLegalHold, {
      method: "POST",
      path: `/api/v1/data-lifecycle/legal-holds/${hold.body.data.legalHold.id}/release`,
      headers: authHeaders(owner, "hold-release-1"),
      params: { id: hold.body.data.legalHold.id },
      body: { releaseReason: "Attempting release under SoD conflict." }
    });

    expect(releaseAttempt.status).toBe(403);
    expect(
      (releaseAttempt.body as { error: { code: string } }).error.code
    ).toBe("SOD_CONFLICT");

    // The conflict evaluation was recorded regardless of outcome.
    const evaluations = (await admin`
      SELECT conflict_detected, resolved_via, trigger_context FROM awcms_mini_sod_conflict_evaluations
      WHERE tenant_id = ${owner.tenantId} AND rule_key = 'data_lifecycle.legal_hold_maker_checker'
    `) as {
      conflict_detected: boolean;
      resolved_via: string;
      trigger_context: string;
    }[];
    expect(evaluations.length).toBeGreaterThan(0);
    expect(
      evaluations.some((row) => row.trigger_context === "high_risk_decision")
    ).toBe(true);
  });

  test("expiry worker (real least-privilege awcms_mini_worker role): an already-elapsed temporary assignment is transitioned to expired and stops contributing to SoD facts", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    const createPerm = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold' AND action = 'create'
    `) as { id: string }[];
    const narrowRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name) VALUES (${owner.tenantId}, 'hold_creator', 'Hold Creator') RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id) VALUES (${owner.tenantId}, ${narrowRole[0]!.id}, ${createPerm[0]!.id})
    `;

    const past = new Date(Date.now() - 60_000);
    const assignmentRows = (await admin`
      INSERT INTO awcms_mini_business_scope_assignments
        (tenant_id, tenant_user_id, role_id, scope_type, scope_id, effective_from, effective_to,
         is_temporary, granted_by_tenant_user_id, status)
      VALUES (
        ${owner.tenantId}, ${owner.tenantUserId}, ${narrowRole[0]!.id}, 'office', ${owner.officeId},
        ${new Date(past.getTime() - 60_000)}, ${past}, true, ${owner.tenantUserId}, 'active'
      )
      RETURNING id
    `) as { id: string }[];

    const workerSql = getWorkerTestSql();
    const result = await runBusinessScopeExpiry(workerSql, {
      runId: "test-run",
      correlationId: "test-corr",
      dryRun: false,
      signal: new AbortController().signal
    });

    expect(result.assignmentsExpired).toBeGreaterThanOrEqual(1);

    const row = (await admin`
      SELECT status FROM awcms_mini_business_scope_assignments WHERE id = ${assignmentRows[0]!.id}
    `) as { status: string }[];
    expect(row[0]!.status).toBe("expired");

    const events = (await admin`
      SELECT event_type FROM awcms_mini_business_scope_assignment_events
      WHERE assignment_id = ${assignmentRows[0]!.id}
    `) as { event_type: string }[];
    expect(events.map((r) => r.event_type)).toEqual(["expired"]);

    // Real re-check: the (now-expired) assignment no longer causes a SoD
    // conflict when releasing a legal hold.
    const hold = await invoke<{ data: { legalHold: { id: string } } }>(
      createLegalHold,
      {
        method: "POST",
        path: "/api/v1/data-lifecycle/legal-holds",
        headers: authHeaders(owner, "hold-create-2"),
        body: {
          descriptorKey: null,
          scopeDescription: "Tenant-wide hold, post-expiry test.",
          reason: "Testing that expiry actually stops SoD enforcement.",
          authorityReference: "TEST-REF-2"
        }
      }
    );
    expect(hold.status).toBe(200);

    const releaseAttempt = await invoke(releaseLegalHold, {
      method: "POST",
      path: `/api/v1/data-lifecycle/legal-holds/${hold.body.data.legalHold.id}/release`,
      headers: authHeaders(owner, "hold-release-2"),
      params: { id: hold.body.data.legalHold.id },
      body: {
        releaseReason: "Should succeed — the conflicting assignment expired."
      }
    });

    expect(releaseAttempt.status).toBe(200);
  });
});
