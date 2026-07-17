/**
 * Dedicated high-risk-path integration coverage for the workflow-approval
 * DECISION endpoint (`POST /api/v1/workflows/tasks/{id}/decisions`), backfilling
 * Issue #827 (epic #818). The existing `workflow-approval.integration.test.ts`
 * already exercises the graph/quorum/delegation/escalation/RLS surface broadly;
 * this file narrows in on the mutation-safety contract a high-risk approval
 * decision MUST hold (doc 07 / doc 10):
 *
 *   1. Idempotent replay: same `Idempotency-Key` + same body -> the stored
 *      response is returned verbatim, the decision is NOT re-applied, and NO
 *      second audit row is written.
 *   2. Cross-resource idempotency isolation (recurring bug #750/#795): the same
 *      `Idempotency-Key` reused against a DIFFERENT task must never replay the
 *      first task's response — the request hash MUST bind the task id. A
 *      collision is refused with 409, and the second task is left untouched.
 *   3. Audit: exactly one audit row per decision.
 *   4. Concurrency: two same-assignee decisions racing on one task must not
 *      double-record / double-transition the instance. NOTE: this currently
 *      REPRODUCES a real quorum-bypass bug (ahliweb/awcms-mini#851); the test is
 *      marked `test.failing` — see the long comment at that test.
 *
 * All four are wired against the real Astro route handlers + real Postgres via
 * the integration harness, exactly like the deployed app (least-privilege app
 * role, FORCE'd RLS).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createDefinition } from "../../src/pages/api/v1/workflows/definitions/index";
import { POST as publishDefinition } from "../../src/pages/api/v1/workflows/definitions/[id]/publish";
import { POST as decideTask } from "../../src/pages/api/v1/workflows/tasks/[id]/decisions";

import { startWorkflowInstance } from "../../src/modules/workflow-approval/application/workflow-instance";
import { createEmailWorkflowNotificationAdapter } from "../../src/modules/email/application/workflow-notification-port-adapter";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const notificationPort = createEmailWorkflowNotificationAdapter();

type Actor = {
  tenantId: string;
  token: string;
  tenantUserId: string;
};

async function bootstrap(): Promise<Actor> {
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
  const rows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId}
      AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: rows[0]!.id
  };
}

function authHeaders(a: Actor): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": a.tenantId,
    authorization: `Bearer ${a.token}`
  };
}

/**
 * Provisions an extra tenant user in the SAME tenant with only the given
 * `workflow.<activityCode>.<action>` permissions. Mirrors the sibling test's
 * `provisionScopedWorkflowUser`.
 */
async function provisionApprover(
  tenantId: string,
  loginIdentifier: string
): Promise<Actor> {
  const password = "integration-test-scoped-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', ${loginIdentifier}) RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, ${`role_${loginIdentifier}`}, ${loginIdentifier}) RETURNING id
    `) as { id: string }[];

    for (const action of ["approve", "read"]) {
      const permission = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE module_key = 'workflow' AND activity_code = 'approval' AND action = ${action}
      `) as { id: string }[];
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
      `;
    }

    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;

    tenantUserId = tenantUser[0]!.id;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token, tenantUserId };
}

async function createAndPublishDefinition(
  owner: Actor,
  workflowKey: string,
  assigneeIds: string[],
  quorumRule: "all" | "any" | "quorum" = "all",
  quorumThreshold?: number
): Promise<void> {
  const created = await invoke<{ data: { definition: { id: string } } }>(
    createDefinition,
    {
      method: "POST",
      path: "/api/v1/workflows/definitions",
      headers: authHeaders(owner),
      body: {
        workflowKey,
        name: `Definition ${workflowKey}`,
        graph: {
          startNodeId: "approve",
          nodes: [
            {
              id: "approve",
              type: "approval",
              name: "Approval",
              assigneeTenantUserIds: assigneeIds,
              quorumRule,
              quorumThreshold,
              onApprove: "end_approved",
              onReject: "end_rejected"
            },
            { id: "end_approved", type: "end", outcome: "approved" },
            { id: "end_rejected", type: "end", outcome: "rejected" }
          ]
        },
        factsSchema: []
      }
    }
  );
  expect(created.status).toBe(200);
  const id = created.body.data.definition.id;

  const published = await invoke(publishDefinition, {
    method: "POST",
    path: `/api/v1/workflows/definitions/${id}/publish`,
    headers: { ...authHeaders(owner), "idempotency-key": crypto.randomUUID() },
    params: { id }
  });
  expect(published.status).toBe(200);
}

/** Starts an instance of `workflowKey` (requester distinct from any assignee) and returns its single pending task id. */
async function startAndGetTaskId(
  owner: Actor,
  workflowKey: string,
  resourceId: string
): Promise<string> {
  const { withTenant } = await import("../../src/lib/database/tenant-context");
  const { getDatabaseClient } = await import("../../src/lib/database/client");
  const sql = getDatabaseClient();

  await withTenant(sql, owner.tenantId, (tx) =>
    startWorkflowInstance(tx, {
      tenantId: owner.tenantId,
      workflowKey,
      resourceType: "test_resource",
      resourceId,
      requestedByTenantUserId: crypto.randomUUID(),
      notificationPort
    })
  );

  // Each test uses a distinct per-test workflowKey + resourceId, so there is
  // exactly one pending task per resource — resolve it directly (the admin
  // connection bypasses RLS, which is fine for fixture lookup).
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT t.id FROM awcms_mini_workflow_tasks t
    JOIN awcms_mini_workflow_instances i ON i.id = t.workflow_instance_id
    WHERE t.tenant_id = ${owner.tenantId} AND i.resource_id = ${resourceId}
      AND t.status = 'pending'
  `) as { id: string }[];
  expect(rows.length).toBe(1);
  return rows[0]!.id;
}

function decisionsCountFor(tenantId: string, taskId: string): Promise<number> {
  const admin = getAdminSql();
  return admin`
    SELECT COUNT(*)::int AS count FROM awcms_mini_workflow_decisions
    WHERE tenant_id = ${tenantId} AND workflow_task_id = ${taskId}
  `.then((r) => (r as { count: number }[])[0]!.count);
}

const suite = integrationEnabled ? describe : describe.skip;

suite("workflow-approval decision hardening (Issue #827)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("idempotent replay: same key + same body returns the stored response verbatim without re-deciding or double-auditing", async () => {
    const owner = await bootstrap();
    const approver = await provisionApprover(owner.tenantId, "a1@example.com");
    await createAndPublishDefinition(owner, "wf_replay", [
      approver.tenantUserId
    ]);
    const taskId = await startAndGetTaskId(owner, "wf_replay", "r-replay");

    const key = crypto.randomUUID();
    const first = await invoke<{
      data: { instanceId: string; instanceStatus: string };
    }>(decideTask, {
      method: "POST",
      path: `/api/v1/workflows/tasks/${taskId}/decisions`,
      headers: { ...authHeaders(approver), "idempotency-key": key },
      params: { id: taskId },
      body: { decision: "approve", reason: "looks good" }
    });
    expect(first.status).toBe(200);
    expect(first.body.data.instanceStatus).toBe("approved");

    const admin = getAdminSql();
    const auditAfterFirst = (await admin`
      SELECT COUNT(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND resource_type = 'workflow_instance'
        AND resource_id = ${first.body.data.instanceId}
        AND action IN ('approve', 'reject')
    `) as { count: number }[];
    expect(auditAfterFirst[0]!.count).toBe(1);
    expect(await decisionsCountFor(owner.tenantId, taskId)).toBe(1);

    // Replay with the SAME key + SAME body: stored response returned verbatim.
    const replay = await invoke<{
      data: { instanceId: string; instanceStatus: string };
    }>(decideTask, {
      method: "POST",
      path: `/api/v1/workflows/tasks/${taskId}/decisions`,
      headers: { ...authHeaders(approver), "idempotency-key": key },
      params: { id: taskId },
      body: { decision: "approve", reason: "looks good" }
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);

    // The decision is NOT applied a second time, and NO second audit row exists.
    expect(await decisionsCountFor(owner.tenantId, taskId)).toBe(1);
    const auditAfterReplay = (await admin`
      SELECT COUNT(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND resource_type = 'workflow_instance'
        AND resource_id = ${first.body.data.instanceId}
        AND action IN ('approve', 'reject')
    `) as { count: number }[];
    expect(auditAfterReplay[0]!.count).toBe(1);
  });

  test("cross-resource idempotency isolation (#750/#795): reusing one key against a different task must not replay the first task's decision", async () => {
    const owner = await bootstrap();
    const approver = await provisionApprover(owner.tenantId, "a2@example.com");
    await createAndPublishDefinition(owner, "wf_cross_a", [
      approver.tenantUserId
    ]);
    await createAndPublishDefinition(owner, "wf_cross_b", [
      approver.tenantUserId
    ]);
    const taskA = await startAndGetTaskId(owner, "wf_cross_a", "r-cross-a");
    const taskB = await startAndGetTaskId(owner, "wf_cross_b", "r-cross-b");

    const sharedKey = crypto.randomUUID();

    const decideA = await invoke<{ data: { instanceId: string } }>(decideTask, {
      method: "POST",
      path: `/api/v1/workflows/tasks/${taskA}/decisions`,
      headers: { ...authHeaders(approver), "idempotency-key": sharedKey },
      params: { id: taskA },
      body: { decision: "approve", reason: "same-reason" }
    });
    expect(decideA.status).toBe(200);

    // Same key, same decision+reason, DIFFERENT task. If the request hash bound
    // only {decision, reason} (the recurring #750/#795 bug), this would REPLAY
    // task A's stored 200 response and leave task B silently un-decided while
    // reporting success. The correct behaviour: the hash includes the task id,
    // so the stored record's hash differs -> 409 IDEMPOTENCY_CONFLICT, and
    // task B is untouched.
    const decideB = await invoke<{ data: { instanceId?: string } }>(
      decideTask,
      {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskB}/decisions`,
        headers: { ...authHeaders(approver), "idempotency-key": sharedKey },
        params: { id: taskB },
        body: { decision: "approve", reason: "same-reason" }
      }
    );
    expect(decideB.status).toBe(409);
    // Task B must remain undecided (never replayed A's success onto B).
    expect(await decisionsCountFor(owner.tenantId, taskB)).toBe(0);
    const admin = getAdminSql();
    const taskBStatus = (await admin`
      SELECT status FROM awcms_mini_workflow_tasks
      WHERE tenant_id = ${owner.tenantId} AND id = ${taskB}
    `) as { status: string }[];
    expect(taskBStatus[0]!.status).toBe("pending");
  });

  // KNOWN BUG (reported: ahliweb/awcms-mini#851) — quorum 'all' bypass via
  // concurrent same-assignee double-submit with different Idempotency-Keys.
  // This test embeds the CORRECT security invariant but is marked
  // `test.failing`: while the bug is present the invariant assertions throw, so
  // the runner reports the test as an EXPECTED failure (green CI). The DAY the
  // bug is fixed (add `SELECT ... FOR UPDATE` on the assignment / a `status =
  // 'pending'` predicate on its UPDATE / a UNIQUE constraint on
  // `awcms_mini_workflow_decisions (workflow_task_id, decided_by_tenant_user_id)`),
  // the invariant will start holding, the test will "unexpectedly pass", and
  // the runner will flip it RED — signalling whoever fixed it to delete the
  // `.failing` marker and keep the assertions as a permanent regression guard.
  //
  // Root cause: `findEligibleAssignment` reads the assignment with a plain
  // SELECT (no row lock) and `recordWorkflowTaskDecision` UPDATEs it to
  // 'decided' WITHOUT a `status = 'pending'` predicate, so under READ COMMITTED
  // two concurrent same-assignee requests both observe 'pending' and both
  // record a decision. With no unique constraint on the decisions table, ONE
  // assignee can thereby satisfy an 'all' quorum that legitimately requires TWO
  // distinct assignees — the instance transitions to `approved` single-handedly.
  test.failing(
    "concurrency: two same-assignee decisions racing on one 'all'-quorum task must not let a single assignee satisfy quorum twice",
    async () => {
      const owner = await bootstrap();
      const approver1 = await provisionApprover(
        owner.tenantId,
        "c1@example.com"
      );
      const approver2 = await provisionApprover(
        owner.tenantId,
        "c2@example.com"
      );

      // Two independent race attempts against fresh tasks so a single scheduling
      // fluke cannot let the (currently vulnerable) path masquerade as safe.
      let worstTotalDecisions = 0;
      let anySingleAssigneeApproval = false;
      let worstSuccessCount = 0;

      for (let attempt = 0; attempt < 2; attempt++) {
        const workflowKey = `wf_race_${attempt}`;
        // Quorum 'all' with TWO distinct assignees: legitimately needs BOTH.
        await createAndPublishDefinition(
          owner,
          workflowKey,
          [approver1.tenantUserId, approver2.tenantUserId],
          "all"
        );
        const taskId = await startAndGetTaskId(
          owner,
          workflowKey,
          `r-race-${attempt}`
        );

        // approver1 fires TWO concurrent approvals with DIFFERENT idempotency
        // keys — the same-key idempotency guard does NOT cover this path.
        const fire = (key: string) =>
          invoke<{ data: { instanceStatus?: string } }>(decideTask, {
            method: "POST",
            path: `/api/v1/workflows/tasks/${taskId}/decisions`,
            headers: { ...authHeaders(approver1), "idempotency-key": key },
            params: { id: taskId },
            body: { decision: "approve" }
          });

        const results = await Promise.all([
          fire(crypto.randomUUID()),
          fire(crypto.randomUUID())
        ]);
        worstSuccessCount = Math.max(
          worstSuccessCount,
          results.filter((r) => r.status === 200).length
        );

        const admin = getAdminSql();
        const rows = (await admin`
          SELECT COUNT(*)::int AS total_count
          FROM awcms_mini_workflow_decisions
          WHERE tenant_id = ${owner.tenantId} AND workflow_task_id = ${taskId}
        `) as { total_count: number }[];
        worstTotalDecisions = Math.max(
          worstTotalDecisions,
          rows[0]!.total_count
        );

        const instanceRow = (await admin`
          SELECT i.status FROM awcms_mini_workflow_instances i
          JOIN awcms_mini_workflow_tasks t ON t.workflow_instance_id = i.id
          WHERE t.tenant_id = ${owner.tenantId} AND t.id = ${taskId}
        `) as { status: string }[];
        if (instanceRow[0]!.status === "approved") {
          anySingleAssigneeApproval = true;
        }
      }

      // INVARIANT (currently violated by the bug): a single assignee must never
      // record more than one decision on one task, at most one of the two
      // concurrent requests may succeed, and a 2-assignee 'all' quorum can never
      // be satisfied — hence approved — by approver1 alone.
      expect(worstTotalDecisions).toBeLessThanOrEqual(1);
      expect(worstSuccessCount).toBeLessThanOrEqual(1);
      expect(anySingleAssigneeApproval).toBe(false);
    }
  );
});
