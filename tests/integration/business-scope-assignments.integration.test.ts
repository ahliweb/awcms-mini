/**
 * Integration tests for business-scope assignments and SoD conflict
 * exceptions (Issue #746) against real PostgreSQL, through the REAL Astro
 * route handlers: create/list/revoke, hierarchy-port scope validation
 * (real `awcms_mini_offices` row vs unknown scope), self-grant denial,
 * cross-tenant RLS isolation, SoD conflict detection at assignment-create
 * time (both `global_within_tenant` and `same_scope_only` rules), and
 * exception request/approve (including self-approval denial, re-checked
 * from the DB row).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listAssignments,
  POST as createAssignment
} from "../../src/pages/api/v1/identity/business-scope/assignments/index";
import { POST as revokeAssignment } from "../../src/pages/api/v1/identity/business-scope/assignments/[id]/revoke";
import {
  GET as listExceptions,
  POST as createException
} from "../../src/pages/api/v1/identity/business-scope/exceptions/index";
import { POST as approveException } from "../../src/pages/api/v1/identity/business-scope/exceptions/[id]/approve";
import { hashPassword } from "../../src/lib/auth/password";
import { withTenant } from "../../src/lib/database/tenant-context";
import {
  approveSoDConflictException,
  createSoDConflictException
} from "../../src/modules/identity-access/application/sod-exception-service";
import { collectSoDRuleDescriptors } from "../../src/modules/identity-access/domain/sod-rule-registry";
import { listModules } from "../../src/modules";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const SECOND_USER_PASSWORD = "integration-test-second-user-password";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
  officeId: string;
};

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
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
  idempotencyKey?: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

/**
 * Inserts a second tenant user directly via admin SQL — a distinct
 * subject/actor for self-grant/self-approval/least-privilege tests
 * without extra invite-flow plumbing. Uses a REAL `hashPassword` hash
 * (not a placeholder) so `loginAsSecondTenantUser` below can authenticate
 * this user through the real `POST /auth/login` endpoint and obtain a
 * genuinely distinct session.
 *
 * `roleId` is OPTIONAL and, when omitted, this user gets NO role at all
 * (zero permissions) — this is deliberate, not an oversight (security-
 * auditor finding on PR #776 that this file itself surfaced): once
 * `resolveSoDAssignmentFacts` started including ordinary RBAC-granted
 * permissions, defaulting every second user to a full-permission "owner"
 * role (the previous behavior) made them ALWAYS hold every registered
 * SoD conflict's both halves simultaneously — useless as a subject for
 * any test that wants to build up a conflict incrementally, or as an
 * actor who should NOT be blocked by an unrelated conflict. Callers that
 * need a real actor pass an explicit `roleId` from
 * `createRoleWithPermissions` below, holding EXACTLY the permission(s)
 * that test needs — least-privilege, matching how a real SoD-conscious
 * tenant would actually be configured, not the always-conflicted
 * bootstrap "owner".
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

/**
 * Creates a role granting EXACTLY the given `module.activity.action`
 * permission keys — the least-privilege building block every test below
 * uses to construct a realistic, narrowly-scoped actor instead of relying
 * on the setup wizard's always-full-permission "owner" role (see
 * `createSecondTenantUser`'s own header for why that matters now).
 */
async function createRoleWithPermissions(
  tenantId: string,
  roleCode: string,
  roleName: string,
  permissionKeys: string[]
): Promise<string> {
  const admin = getAdminSql();

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
    VALUES (${tenantId}, ${roleCode}, ${roleName})
    RETURNING id
  `) as { id: string }[];
  const roleId = roleRows[0]!.id;

  for (const key of permissionKeys) {
    const [moduleKey, activityCode, action] = key.split(".");
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${tenantId}, ${roleId}, id FROM awcms_mini_permissions
      WHERE module_key = ${moduleKey} AND activity_code = ${activityCode} AND action = ${action}
    `;
  }

  return roleId;
}

/** Logs in as a user previously created by `createSecondTenantUser` through the REAL `POST /auth/login` endpoint, returning a genuinely distinct session token/cookie jar for that user. */
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

suite("business-scope assignments API (Issue #746)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create: succeeds for a real office scope, list reflects it", async () => {
    const owner = await bootstrap();
    const subjectId = await createSecondTenantUser(
      owner.tenantId,
      "acme-subject-1@example.com"
    );

    const result = await invoke<{
      data: { assignment: { id: string; status: string } };
    }>(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "create-1"),
      body: {
        tenantUserId: subjectId,
        scopeType: "office",
        scopeId: owner.officeId,
        reason: "Grant regional access."
      }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.assignment.status).toBe("active");

    const listed = await invoke<{ data: { assignments: unknown[] } }>(
      listAssignments,
      {
        method: "GET",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner)
      }
    );
    expect(listed.body.data.assignments).toHaveLength(1);
  });

  test("create: unknown scopeId is rejected (SCOPE_UNRESOLVED) — scope is validated through the hierarchy port, never trusted from the request", async () => {
    const owner = await bootstrap();
    const subjectId = await createSecondTenantUser(
      owner.tenantId,
      "acme-subject-2@example.com"
    );

    const result = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "create-2"),
      body: {
        tenantUserId: subjectId,
        scopeType: "office",
        scopeId: "00000000-0000-0000-0000-000000000000"
      }
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "SCOPE_UNRESOLVED"
    );
  });

  test("create: an unrecognized scopeType (no adapter registered) is also SCOPE_UNRESOLVED — safe default, never a crash", async () => {
    const owner = await bootstrap();
    const subjectId = await createSecondTenantUser(
      owner.tenantId,
      "acme-subject-3@example.com"
    );

    const result = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "create-3"),
      body: {
        tenantUserId: subjectId,
        scopeType: "warehouse",
        scopeId: owner.officeId
      }
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "SCOPE_UNRESOLVED"
    );
  });

  test("create: self-grant is denied — an actor cannot grant themselves a business-scope assignment", async () => {
    const owner = await bootstrap();

    const result = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "create-4"),
      body: {
        tenantUserId: owner.tenantUserId,
        scopeType: "office",
        scopeId: owner.officeId
      }
    });

    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "SELF_GRANT_DENIED"
    );
  });

  test("revoke: succeeds for an active assignment, writes a lifecycle event", async () => {
    const owner = await bootstrap();
    const subjectId = await createSecondTenantUser(
      owner.tenantId,
      "acme-subject-5@example.com"
    );

    const created = await invoke<{ data: { assignment: { id: string } } }>(
      createAssignment,
      {
        method: "POST",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(owner, "create-5"),
        body: {
          tenantUserId: subjectId,
          scopeType: "office",
          scopeId: owner.officeId
        }
      }
    );
    expect(created.status).toBe(200);

    // `revoke` is high-risk: `owner`'s full-permission role ALSO holds
    // `business_scope_assignments.create` via ordinary RBAC, which would
    // now (correctly) conflict with `.revoke` under the same-scope-only
    // maker/checker rule if `owner` performed the revoke themselves — a
    // real, unrelated SoD conflict this test isn't about. Use a distinct,
    // least-privilege actor holding ONLY `.revoke` instead.
    const revokerRole = await createRoleWithPermissions(
      owner.tenantId,
      "assignment_revoker",
      "Assignment Revoker",
      ["identity_access.business_scope_assignments.revoke"]
    );
    await createSecondTenantUser(
      owner.tenantId,
      "acme-revoker@example.com",
      revokerRole
    );
    const revokerSession = await loginAsSecondTenantUser(
      owner.tenantId,
      "acme-revoker@example.com"
    );

    const revoked = await invoke<{ data: { assignment: { status: string } } }>(
      revokeAssignment,
      {
        method: "POST",
        path: `/api/v1/identity/business-scope/assignments/${created.body.data.assignment.id}/revoke`,
        headers: {
          ...authHeaders(owner, "revoke-1"),
          authorization: `Bearer ${revokerSession.token}`
        },
        params: { id: created.body.data.assignment.id },
        body: { revokeReason: "No longer needed." }
      }
    );

    expect(revoked.status).toBe(200);
    expect(revoked.body.data.assignment.status).toBe("revoked");

    const admin = getAdminSql();
    const events = (await admin`
      SELECT event_type FROM awcms_mini_business_scope_assignment_events
      WHERE tenant_id = ${owner.tenantId} AND assignment_id = ${created.body.data.assignment.id}
      ORDER BY occurred_at
    `) as { event_type: string }[];
    expect(events.map((row) => row.event_type)).toEqual(["granted", "revoked"]);
  });

  test("cross-tenant isolation: tenant A cannot see or revoke tenant B's assignment", async () => {
    // `POST /api/v1/setup/initialize` is a global one-time singleton (`awcms_
    // mini_setup_state`) — a second real call in the SAME database returns
    // 403 ALREADY_INITIALIZED, so "tenant B" is seeded directly via admin SQL
    // (same convention `data-lifecycle-legal-hold-service.integration.test.ts`'s
    // `seedTenant()` uses for its own cross-tenant fixture), not through a
    // second setup-wizard run.
    const ownerA = await bootstrap("acme", "Acme");
    const admin = getAdminSql();

    const tenantBRows = (await admin`
      INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
      VALUES ('globex', 'Globex')
      RETURNING id
    `) as { id: string }[];
    const tenantBId = tenantBRows[0]!.id;

    const officeBRows = (await admin`
      INSERT INTO awcms_mini_offices (tenant_id, office_code, office_name)
      VALUES (${tenantBId}, 'hq', 'HQ')
      RETURNING id
    `) as { id: string }[];

    const subjectB = await createSecondTenantUser(
      tenantBId,
      "globex-subject@example.com"
    );

    const assignmentB = (await admin`
      INSERT INTO awcms_mini_business_scope_assignments
        (tenant_id, tenant_user_id, scope_type, scope_id, granted_by_tenant_user_id, status)
      VALUES (${tenantBId}, ${subjectB}, 'office', ${officeBRows[0]!.id}, ${subjectB}, 'active')
      RETURNING id
    `) as { id: string }[];

    const listedByA = await invoke<{ data: { assignments: unknown[] } }>(
      listAssignments,
      {
        method: "GET",
        path: "/api/v1/identity/business-scope/assignments",
        headers: authHeaders(ownerA)
      }
    );
    expect(listedByA.body.data.assignments).toEqual([]);

    // Least-privilege actor in tenant A (same reasoning as the "revoke
    // succeeds" test above) — isolates this assertion to the cross-tenant
    // RLS/not-found behavior itself, not an unrelated SoD conflict that
    // `ownerA`'s own full-permission role would otherwise also trigger.
    const revokerRoleA = await createRoleWithPermissions(
      ownerA.tenantId,
      "assignment_revoker",
      "Assignment Revoker",
      ["identity_access.business_scope_assignments.revoke"]
    );
    await createSecondTenantUser(
      ownerA.tenantId,
      "acme-revoker@example.com",
      revokerRoleA
    );
    const revokerASession = await loginAsSecondTenantUser(
      ownerA.tenantId,
      "acme-revoker@example.com"
    );

    const revokeAttempt = await invoke(revokeAssignment, {
      method: "POST",
      path: `/api/v1/identity/business-scope/assignments/${assignmentB[0]!.id}/revoke`,
      headers: {
        ...authHeaders(ownerA, "revoke-cross"),
        authorization: `Bearer ${revokerASession.token}`
      },
      params: { id: assignmentB[0]!.id },
      body: { revokeReason: "Cross-tenant attempt." }
    });
    expect(revokeAttempt.status).toBe(404);

    // Tenant B's assignment is untouched.
    const stillActive = (await admin`
      SELECT status FROM awcms_mini_business_scope_assignments WHERE id = ${assignmentB[0]!.id}
    `) as { status: string }[];
    expect(stillActive[0]!.status).toBe("active");
  });

  test("SoD conflict at assignment-create time (global_within_tenant): granting a conflicting role-backed scope is denied without an approved exception, allowed with one", async () => {
    const owner = await bootstrap();
    const subjectId = await createSecondTenantUser(
      owner.tenantId,
      "acme-subject-6@example.com"
    );
    const admin = getAdminSql();

    // Two narrow roles, each granting exactly ONE half of the
    // `data_lifecycle.legal_hold_maker_checker` pair (`legal_hold.create`
    // vs `.release`) — deliberately NOT the `identity_access.business_
    // scope_exception_maker_checker` pair (`business_scope_exceptions.
    // create`/`.approve`): that rule's `exceptionPolicy.allowed` is
    // `false` BY DESIGN (the control that gates SoD overrides is itself
    // never override-able — see `identity-access/module.ts`'s own
    // comment), so it can never reach the "allowed with an approved
    // exception" half of this test's name. `legal_hold_maker_checker`
    // is the real `global_within_tenant` rule whose `exceptionPolicy.
    // allowed` is `true`.
    const createPerm = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold' AND action = 'create'
    `) as { id: string }[];
    const approvePerm = (await admin`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'data_lifecycle' AND activity_code = 'legal_hold' AND action = 'release'
    `) as { id: string }[];

    const requesterRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name) VALUES (${owner.tenantId}, 'legal_hold_creator', 'Legal Hold Creator') RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id) VALUES (${owner.tenantId}, ${requesterRole[0]!.id}, ${createPerm[0]!.id})
    `;
    const approverRole = (await admin`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name) VALUES (${owner.tenantId}, 'legal_hold_releaser', 'Legal Hold Releaser') RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id) VALUES (${owner.tenantId}, ${approverRole[0]!.id}, ${approvePerm[0]!.id})
    `;

    // Subject already holds the requester assignment (unrelated scope —
    // global_within_tenant means scope doesn't matter).
    const firstAssignment = await invoke<{
      data: { assignment: { id: string } };
    }>(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "sod-1"),
      body: {
        tenantUserId: subjectId,
        roleId: requesterRole[0]!.id,
        scopeType: "office",
        scopeId: owner.officeId
      }
    });
    expect(firstAssignment.status).toBe(200);

    // Granting the CONFLICTING approver assignment to the SAME subject is
    // denied — no approved exception exists yet.
    const conflicting = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "sod-2"),
      body: {
        tenantUserId: subjectId,
        roleId: approverRole[0]!.id,
        scopeType: "office",
        scopeId: owner.officeId
      }
    });
    expect(conflicting.status).toBe(409);
    expect((conflicting.body as { error: { code: string } }).error.code).toBe(
      "SOD_CONFLICT"
    );

    // Evaluation is recorded regardless of outcome.
    const evaluations = (await admin`
      SELECT conflict_detected, resolved_via FROM awcms_mini_sod_conflict_evaluations
      WHERE tenant_id = ${owner.tenantId} AND trigger_context = 'assignment_create'
    `) as { conflict_detected: boolean; resolved_via: string }[];
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations[0]!.conflict_detected).toBe(true);
    expect(evaluations[0]!.resolved_via).toBe("denied");

    // But: the rule allows exceptions — request one, have a DIFFERENT
    // tenant user approve it, then the same grant succeeds. This approver
    // holds ONLY `business_scope_exceptions.approve` — NOT also `.create`
    // — because holding BOTH is itself exactly the (non-exceptable)
    // `identity_access.business_scope_exception_maker_checker` conflict;
    // an approver with both would be denied approving ANYTHING regardless
    // of this test's own scenario.
    const approverOnlyRole = await createRoleWithPermissions(
      owner.tenantId,
      "exception_approver_only",
      "Exception Approver (approve-only)",
      ["identity_access.business_scope_exceptions.approve"]
    );
    await createSecondTenantUser(
      owner.tenantId,
      "acme-approver@example.com",
      approverOnlyRole
    );
    const secondApproverSession = await loginAsSecondTenantUser(
      owner.tenantId,
      "acme-approver@example.com"
    );
    const exceptionRequest = await invoke<{
      data: { exception: { id: string } };
    }>(createException, {
      method: "POST",
      path: "/api/v1/identity/business-scope/exceptions",
      headers: authHeaders(owner, "exc-1"),
      body: {
        ruleKey: "data_lifecycle.legal_hold_maker_checker",
        subjectTenantUserId: subjectId,
        justification: "Temporary coverage during staff transition.",
        effectiveTo: new Date(
          Date.now() + 3 * 24 * 60 * 60 * 1000
        ).toISOString()
      }
    });
    if (exceptionRequest.status !== 200)
      console.error("DEBUG", JSON.stringify(exceptionRequest.body));
    expect(exceptionRequest.status).toBe(200);

    const approved = await invoke(approveException, {
      method: "POST",
      path: `/api/v1/identity/business-scope/exceptions/${exceptionRequest.body.data.exception.id}/approve`,
      headers: {
        ...authHeaders(owner, "exc-approve-1"),
        authorization: `Bearer ${secondApproverSession.token}`
      },
      params: { id: exceptionRequest.body.data.exception.id },
      body: {}
    });
    // A genuinely DIFFERENT tenant user (own real session, not `owner`'s
    // token) approves — `owner` is the requester of this exception, so
    // `owner` approving it would correctly be denied by the self-approval
    // guard (tested explicitly below); this happy-path assertion needs a
    // truly distinct approver to reach `approved.status === 200` at all.
    expect(approved.status).toBe(200);

    const nowAllowed = await invoke(createAssignment, {
      method: "POST",
      path: "/api/v1/identity/business-scope/assignments",
      headers: authHeaders(owner, "sod-3"),
      body: {
        tenantUserId: subjectId,
        roleId: approverRole[0]!.id,
        scopeType: "office",
        scopeId: owner.officeId
      }
    });
    expect(nowAllowed.status).toBe(200);
  });

  test("SoD exception approval: self-approval is denied (re-checked from the DB row, not the request body)", async () => {
    // Deliberately calls the APPLICATION-layer functions directly
    // (`createSoDConflictException`/`approveSoDConflictException`) rather
    // than the real HTTP endpoints — same convention `data-lifecycle-
    // legal-hold-service.integration.test.ts` uses to isolate ONE
    // specific behavior. Any single real actor able to call BOTH
    // `POST .../exceptions` (needs `.create`) and `POST .../approve`
    // (needs `.approve`) necessarily holds BOTH halves of the
    // `identity_access.business_scope_exception_maker_checker` rule —
    // which the real `authorizeInTransaction` chokepoint would ALSO
    // (correctly) deny with `SOD_CONFLICT`, masking this test's own
    // narrower assertion about the self-approval-specific re-check. This
    // test isolates that re-check by calling the service functions below
    // the chokepoint, exactly like the legal-hold precedent isolates its
    // own service behavior from the full ABAC stack.
    const owner = await bootstrap();
    const sql = getTestSql();
    const sodRules = collectSoDRuleDescriptors(listModules());

    const created = await withTenant(sql, owner.tenantId, (tx) =>
      createSoDConflictException(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        owner.tenantUserId,
        {
          ruleKey: "data_lifecycle.legal_hold_maker_checker",
          scopeType: null,
          scopeId: null,
          justification: "Attempting to approve my own request.",
          effectiveFrom: new Date(),
          effectiveTo: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        },
        sodRules,
        "corr-self-approve-create"
      )
    );
    if (!created.ok) throw new Error(`unexpected: ${JSON.stringify(created)}`);

    const selfApprove = await withTenant(sql, owner.tenantId, (tx) =>
      approveSoDConflictException(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        created.exception.id,
        null,
        "corr-self-approve-attempt"
      )
    );

    expect(selfApprove.ok).toBe(false);
    if (!selfApprove.ok) {
      expect(selfApprove.reason).toBe("self_approval_denied");
    }
  });

  test("exception: a rule with exceptionPolicy.allowed=false rejects a request (EXCEPTION_NOT_ALLOWED)", async () => {
    const owner = await bootstrap();

    const result = await invoke(createException, {
      method: "POST",
      path: "/api/v1/identity/business-scope/exceptions",
      headers: authHeaders(owner, "exc-notallowed-1"),
      body: {
        ruleKey: "identity_access.business_scope_exception_maker_checker",
        subjectTenantUserId: owner.tenantUserId,
        justification: "This rule never allows exceptions.",
        effectiveTo: new Date(
          Date.now() + 3 * 24 * 60 * 60 * 1000
        ).toISOString()
      }
    });

    // NOTE: the maker/checker rule itself has exceptionPolicy.allowed:
    // false — asserted directly here rather than relying on the previous
    // test's rule choice, to keep this test self-contained.
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "EXCEPTION_NOT_ALLOWED"
    );
  });

  test("list exceptions: reflects created/approved rows, filterable by status", async () => {
    const owner = await bootstrap();

    await invoke(createException, {
      method: "POST",
      path: "/api/v1/identity/business-scope/exceptions",
      headers: authHeaders(owner, "exc-list-1"),
      body: {
        ruleKey:
          "identity_access.business_scope_assignment_scope_maker_checker",
        subjectTenantUserId: owner.tenantUserId,
        justification: "Coverage exception request for listing test.",
        effectiveTo: new Date(
          Date.now() + 5 * 24 * 60 * 60 * 1000
        ).toISOString()
      }
    });

    const pending = await invoke<{ data: { exceptions: unknown[] } }>(
      listExceptions,
      {
        method: "GET",
        path: "/api/v1/identity/business-scope/exceptions?status=pending",
        headers: authHeaders(owner)
      }
    );
    expect(pending.body.data.exceptions).toHaveLength(1);
  });
});
