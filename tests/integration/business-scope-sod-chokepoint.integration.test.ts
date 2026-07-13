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
import { hashPassword } from "../../src/lib/auth/password";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const SECOND_USER_PASSWORD = "integration-test-second-user-password";

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

/**
 * Least-privilege second tenant user (see `business-scope-assignments.
 * integration.test.ts`'s `createSecondTenantUser` for the same reasoning)
 * — `roleId` is optional and, when omitted, grants NO ordinary RBAC role
 * at all, deliberately avoiding the setup-wizard "owner" full-permission
 * role that would otherwise always conflict with every registered SoD
 * rule simultaneously.
 */
async function createSecondTenantUser(
  tenantId: string,
  loginIdentifier: string,
  roleId?: string
): Promise<string> {
  const admin = getAdminSql();

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Second User')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(SECOND_USER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];

  if (roleId) {
    await admin`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUserRows[0]!.id}, ${roleId})
    `;
  }

  return tenantUserRows[0]!.id;
}

async function loginAsSecondTenantUser(
  tenantId: string,
  loginIdentifier: string
): Promise<{ token: string }> {
  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password: SECOND_USER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);
  return { token: login.body.data.token };
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

  test("real chokepoint, ORDINARY RBAC ALONE — no business-scope assignment layering at all: a subject whose role grants BOTH legal_hold.create AND .release via plain awcms_mini_access_assignments is DENIED releasing a legal hold (security-auditor finding on PR #776)", async () => {
    // Deliberately does NOT create, seed, or reference
    // `awcms_mini_business_scope_assignments` anywhere in this test — the
    // ENTIRE conflict is manufactured through the same ordinary RBAC path
    // (`awcms_mini_access_assignments` -> `awcms_mini_role_permissions`)
    // every other authorization check in this codebase already uses.
    // This is the realistic case the original version of
    // `resolveSoDAssignmentFacts` silently missed: a tenant granting one
    // role that happens to hold both halves of a registered conflict.
    const owner = await bootstrap();
    const admin = getAdminSql();

    const bothPerms = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold'
        AND action IN ('create', 'release')
    `) as { id: string }[];
    expect(bothPerms).toHaveLength(2);

    const conflictedRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${owner.tenantId}, 'legal_hold_manager', 'Legal Hold Manager (create+release)')
      RETURNING id
    `) as { id: string }[];
    for (const perm of bothPerms) {
      await admin`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${owner.tenantId}, ${conflictedRole[0]!.id}, ${perm.id})
      `;
    }

    const managerId = await createSecondTenantUser(
      owner.tenantId,
      "acme-hold-manager@example.com",
      conflictedRole[0]!.id
    );
    const managerSession = await loginAsSecondTenantUser(
      owner.tenantId,
      "acme-hold-manager@example.com"
    );

    const hold = await invoke<{ data: { legalHold: { id: string } } }>(
      createLegalHold,
      {
        method: "POST",
        path: "/api/v1/data-lifecycle/legal-holds",
        headers: {
          ...authHeaders(owner, "rbac-hold-create-1"),
          authorization: `Bearer ${managerSession.token}`
        },
        body: {
          descriptorKey: null,
          scopeDescription: "Tenant-wide hold, RBAC-only conflict test.",
          reason: "Testing SoD conflict detection via ordinary RBAC alone.",
          authorityReference: "TEST-REF-RBAC-1"
        }
      }
    );
    expect(hold.status).toBe(200);

    const releaseAttempt = await invoke(releaseLegalHold, {
      method: "POST",
      path: `/api/v1/data-lifecycle/legal-holds/${hold.body.data.legalHold.id}/release`,
      headers: {
        ...authHeaders(owner, "rbac-hold-release-1"),
        authorization: `Bearer ${managerSession.token}`
      },
      params: { id: hold.body.data.legalHold.id },
      body: {
        releaseReason: "Attempting release under RBAC-only SoD conflict."
      }
    });

    expect(releaseAttempt.status).toBe(403);
    expect(
      (releaseAttempt.body as { error: { code: string } }).error.code
    ).toBe("SOD_CONFLICT");

    // No business-scope assignment exists for this subject at all —
    // confirms the conflict was detected purely from the ordinary RBAC
    // fact path, not from any business-scope-assignment-derived fact.
    const assignmentRows = (await admin`
      SELECT id FROM awcms_mini_business_scope_assignments
      WHERE tenant_id = ${owner.tenantId} AND tenant_user_id = ${managerId}
    `) as { id: string }[];
    expect(assignmentRows).toHaveLength(0);

    const evaluations = (await admin`
      SELECT conflict_detected, resolved_via, trigger_context, subject_tenant_user_id
      FROM awcms_mini_sod_conflict_evaluations
      WHERE tenant_id = ${owner.tenantId} AND rule_key = 'data_lifecycle.legal_hold_maker_checker'
        AND subject_tenant_user_id = ${managerId}
    `) as {
      conflict_detected: boolean;
      resolved_via: string;
      trigger_context: string;
    }[];
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations.every((row) => row.conflict_detected)).toBe(true);
    expect(evaluations.every((row) => row.resolved_via === "denied")).toBe(
      true
    );
  });

  test("expiry worker (real least-privilege awcms_mini_worker role): an already-elapsed temporary assignment is transitioned to expired and stops contributing to SoD facts", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    // A DISTINCT, least-privilege actor holds `legal_hold.release`
    // PERMANENTLY via ordinary RBAC (never `.create` — `owner`'s
    // full-permission role is deliberately NOT used here: it always holds
    // BOTH halves of this conflict via RBAC alone regardless of any
    // business-scope assignment, so it could never demonstrate "the
    // EXPIRED assignment specifically stopped counting").
    const releasePerm = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold' AND action = 'release'
    `) as { id: string }[];
    const releaserRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name) VALUES (${owner.tenantId}, 'hold_releaser', 'Hold Releaser') RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id) VALUES (${owner.tenantId}, ${releaserRole[0]!.id}, ${releasePerm[0]!.id})
    `;
    const releaserSubjectId = await createSecondTenantUser(
      owner.tenantId,
      "acme-releaser@example.com",
      releaserRole[0]!.id
    );
    const releaserSession = await loginAsSecondTenantUser(
      owner.tenantId,
      "acme-releaser@example.com"
    );

    // The SAME actor holds `legal_hold.create` only TEMPORARILY, via an
    // already-elapsed business-scope assignment.
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
        ${owner.tenantId}, ${releaserSubjectId}, ${narrowRole[0]!.id}, 'office', ${owner.officeId},
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
    // conflict when releasing a legal hold — `owner` (full permissions,
    // unaffected by this specific actor's now-expired assignment) creates
    // the hold; the least-privilege releaser (who no longer holds
    // `.create` at all, only `.release` via their permanent RBAC role)
    // releases it.
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
      headers: {
        ...authHeaders(owner, "hold-release-2"),
        authorization: `Bearer ${releaserSession.token}`
      },
      params: { id: hold.body.data.legalHold.id },
      body: {
        releaseReason: "Should succeed — the conflicting assignment expired."
      }
    });

    expect(releaseAttempt.status).toBe(200);
  });

  test("expiry worker --dry-run reports the REAL non-zero backlog against a seeded expired-but-not-yet-transitioned row (security-auditor finding on PR #776)", async () => {
    // The ORIGINAL dry-run branch queried
    // `awcms_mini_business_scope_assignments`/`..._sod_conflict_exceptions`
    // directly via the bare worker `sql` client with NO `withTenant`
    // wrapping — since both tables are `FORCE ROW LEVEL SECURITY`'d and
    // `awcms_mini_worker`'s session-level `app.current_tenant_id` defaults
    // to the all-zero UUID (migration 045's fail-closed design), that
    // COUNT was always silently scoped to a tenant that does not exist,
    // reporting a false "nothing to expire" on every real backlog. This
    // test seeds a genuinely expired row and asserts `--dry-run` actually
    // reports it (and does NOT mutate it).
    const owner = await bootstrap();
    const admin = getAdminSql();

    const createPerm = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold' AND action = 'create'
    `) as { id: string }[];
    const narrowRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name) VALUES (${owner.tenantId}, 'hold_creator_dryrun', 'Hold Creator (dry-run test)') RETURNING id
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
      runId: "test-run-dry",
      correlationId: "test-corr-dry",
      dryRun: true,
      signal: new AbortController().signal
    });

    expect(result.tenantsChecked).toBeGreaterThanOrEqual(1);
    expect(result.assignmentsExpired).toBeGreaterThanOrEqual(1);

    // Dry-run must not mutate anything — the row is still `active`.
    const row = (await admin`
      SELECT status FROM awcms_mini_business_scope_assignments WHERE id = ${assignmentRows[0]!.id}
    `) as { status: string }[];
    expect(row[0]!.status).toBe("active");

    const events = (await admin`
      SELECT id FROM awcms_mini_business_scope_assignment_events
      WHERE assignment_id = ${assignmentRows[0]!.id}
    `) as { id: string }[];
    expect(events).toHaveLength(0);
  });
});
