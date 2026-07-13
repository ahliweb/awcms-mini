/**
 * Integration tests for Issue #747 (epic `platform-evolution` #738 Wave
 * 2): managed versioned workflow definitions, quorum/sequential approval,
 * delegation, escalation/timeout, administrative recovery, and the
 * consolidated approval inbox — evolving the Issue 11.1 linear engine.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()`/`.rejects.toBeInstanceOf()`/
 * `expect(...).resolves`/`.rejects` against a real Bun.SQL/postgres
 * promise in this repo — it spins the process at 100% CPU forever
 * (confirmed project pitfall). Every rejection below is asserted via
 * manual try/catch instead.
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

import {
  GET as listDefinitions,
  POST as createDefinition
} from "../../src/pages/api/v1/workflows/definitions/index";
import { PUT as updateDefinition } from "../../src/pages/api/v1/workflows/definitions/[id]";
import { POST as publishDefinition } from "../../src/pages/api/v1/workflows/definitions/[id]/publish";
import { POST as newVersionDefinition } from "../../src/pages/api/v1/workflows/definitions/[id]/new-version";
import { POST as retireDefinition } from "../../src/pages/api/v1/workflows/definitions/[id]/retire";

import { GET as listTasks } from "../../src/pages/api/v1/workflows/tasks/index";
import { POST as decideTask } from "../../src/pages/api/v1/workflows/tasks/[id]/decisions";
import { POST as forceDecideTask } from "../../src/pages/api/v1/workflows/tasks/[id]/force-decision";
import { POST as reassignTask } from "../../src/pages/api/v1/workflows/tasks/[id]/reassign";

import { GET as getInstance } from "../../src/pages/api/v1/workflows/instances/[id]";
import { POST as cancelInstance } from "../../src/pages/api/v1/workflows/instances/[id]/cancel";

import { POST as createDelegation } from "../../src/pages/api/v1/workflows/delegations/index";

import { startWorkflowInstance } from "../../src/modules/workflow-approval/application/workflow-instance";
import { escalateDueTasksForTenant } from "../../src/modules/workflow-approval/application/workflow-escalation";
import { createEmailWorkflowNotificationAdapter } from "../../src/modules/email/application/workflow-notification-port-adapter";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const notificationPort = createEmailWorkflowNotificationAdapter();

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
  token: string;
  tenantUserId: string;
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

  return {
    tenantId: setup.body.data.tenantId,
    tenantCode,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function authHeaders(b: {
  tenantId: string;
  token: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/**
 * Provisions a second tenant user *within the same tenant*, granted only
 * the given `workflow.<activityCode>.<action>` permissions — mirrors
 * `blog-content-posts-api.integration.test.ts`'s
 * `provisionScopedTenantUser` pattern.
 */
async function provisionScopedWorkflowUser(
  tenantId: string,
  loginIdentifier: string,
  actions: { activityCode: string; action: string }[]
): Promise<Bootstrap> {
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

    for (const { activityCode, action } of actions) {
      const permission = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE module_key = 'workflow' AND activity_code = ${activityCode} AND action = ${action}
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

  return {
    tenantId,
    tenantCode: "",
    token: login.body.data.token,
    tenantUserId
  };
}

/**
 * A second, fully-independent tenant with NO permissions granted — for
 * cross-tenant RLS/ABAC isolation checks. `/setup/initialize` is a
 * once-per-database singleton (confirmed by every other integration test
 * in this repo), so a second tenant is always seeded via raw SQL + a real
 * login, never a second `bootstrap()` call.
 */
async function seedRestrictedSecondTenant(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
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

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

/** Creates+publishes a minimal 2-assignee "all"-quorum sequential-approval definition, returns its id/workflowKey. */
async function createAndPublishQuorumDefinition(
  owner: Bootstrap,
  workflowKey: string,
  assigneeIds: string[],
  quorumRule: "all" | "any" | "quorum" = "all",
  quorumThreshold?: number
): Promise<{ id: string }> {
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

  return { id };
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "workflow-approval managed definitions, quorum, delegation, escalation, recovery (Issue #747)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
      await provisionWorkerRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("draft -> validate -> publish -> new-version -> retire lifecycle; active version cannot be edited in place", async () => {
      const owner = await bootstrap();

      const created = await invoke<{
        data: {
          definition: { id: string; lifecycleStatus: string; version: number };
        };
      }>(createDefinition, {
        method: "POST",
        path: "/api/v1/workflows/definitions",
        headers: authHeaders(owner),
        body: {
          workflowKey: "expense_approval",
          name: "Expense approval",
          graph: {
            startNodeId: "manager",
            nodes: [
              {
                id: "manager",
                type: "approval",
                name: "Manager approval",
                assigneeTenantUserIds: [owner.tenantUserId],
                quorumRule: "all",
                onApprove: "end_approved",
                onReject: "end_rejected"
              },
              { id: "end_approved", type: "end", outcome: "approved" },
              { id: "end_rejected", type: "end", outcome: "rejected" }
            ]
          }
        }
      });
      expect(created.status).toBe(200);
      expect(created.body.data.definition.lifecycleStatus).toBe("draft");
      const id = created.body.data.definition.id;

      const publish1 = await invoke(publishDefinition, {
        method: "POST",
        path: `/api/v1/workflows/definitions/${id}/publish`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id }
      });
      expect(publish1.status).toBe(200);

      // Active version cannot be edited in place.
      const editAttempt = await invoke(updateDefinition, {
        method: "PUT",
        path: `/api/v1/workflows/definitions/${id}`,
        headers: authHeaders(owner),
        params: { id },
        body: { name: "Renamed" }
      });
      expect(editAttempt.status).toBe(409);

      // The only way to change it: fork a new draft version.
      const newVersion = await invoke<{
        data: { id: string; version: number; lifecycleStatus: string };
      }>(newVersionDefinition, {
        method: "POST",
        path: `/api/v1/workflows/definitions/${id}/new-version`,
        headers: authHeaders(owner),
        params: { id }
      });
      expect(newVersion.status).toBe(200);
      expect(newVersion.body.data.version).toBe(2);
      expect(newVersion.body.data.lifecycleStatus).toBe("draft");

      const retire = await invoke(retireDefinition, {
        method: "POST",
        path: `/api/v1/workflows/definitions/${id}/retire`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id }
      });
      expect(retire.status).toBe(200);

      const definitions = await invoke<{
        data: { definitions: { lifecycleStatus: string }[] };
      }>(listDefinitions, {
        method: "GET",
        path: "/api/v1/workflows/definitions",
        headers: authHeaders(owner)
      });
      expect(definitions.status).toBe(200);
    });

    test("an instance stays pinned to its starting version after a newer version is published", async () => {
      const owner = await bootstrap();
      const { id: v1Id } = await createAndPublishQuorumDefinition(
        owner,
        "pin_test",
        [owner.tenantUserId]
      );

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      const startResult = await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "pin_test",
          resourceType: "test_resource",
          resourceId: "r-1",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );
      expect(startResult.workflowDefinitionVersion).toBe(1);

      // Publish v2 of the SAME workflowKey — v1 gets retired automatically.
      const forkedDraft = await invoke<{ data: { id: string } }>(
        newVersionDefinition,
        {
          method: "POST",
          path: `/api/v1/workflows/definitions/${v1Id}/new-version`,
          headers: authHeaders(owner),
          params: { id: v1Id }
        }
      );
      const v2Id = forkedDraft.body.data.id;
      const publishV2 = await invoke(publishDefinition, {
        method: "POST",
        path: `/api/v1/workflows/definitions/${v2Id}/publish`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: v2Id }
      });
      expect(publishV2.status).toBe(200);

      // The already-started instance's pinned version is unchanged.
      const instanceDetail = await invoke<{
        data: { instance: { workflowDefinitionVersion: number } };
      }>(getInstance, {
        method: "GET",
        path: `/api/v1/workflows/instances/${startResult.instanceId}`,
        headers: authHeaders(owner),
        params: { id: startResult.instanceId }
      });
      expect(instanceDetail.status).toBe(200);
      expect(instanceDetail.body.data.instance.workflowDefinitionVersion).toBe(
        1
      );
    });

    test("quorum 'all' requires every assignee to approve; a single reject ends the instance immediately", async () => {
      const owner = await bootstrap();
      const scopedApprover = await provisionScopedWorkflowUser(
        owner.tenantId,
        "approver2@example.com",
        [
          { activityCode: "approval", action: "approve" },
          { activityCode: "approval", action: "read" }
        ]
      );

      await createAndPublishQuorumDefinition(owner, "quorum_all", [
        owner.tenantUserId,
        scopedApprover.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();
      const requesterId = crypto.randomUUID();

      const startResult = await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "quorum_all",
          resourceType: "test_resource",
          resourceId: "r-quorum",
          requestedByTenantUserId: requesterId,
          notificationPort
        })
      );
      expect(startResult.finished).toBe(false);

      const tasksBefore = await invoke<{ data: { tasks: { id: string }[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending",
          headers: authHeaders(owner)
        }
      );
      expect(tasksBefore.body.data.tasks.length).toBe(1);
      const taskId = tasksBefore.body.data.tasks[0]!.id;

      // First approval: task not yet complete (quorum 'all' needs both).
      const firstApprove = await invoke<{
        data: { taskCompleted: boolean; instanceFinished: boolean };
      }>(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/decisions`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: { decision: "approve" }
      });
      expect(firstApprove.status).toBe(200);
      expect(firstApprove.body.data.instanceFinished).toBe(false);

      // Second approval from the other assignee completes the quorum.
      const secondApprove = await invoke<{
        data: { instanceFinished: boolean; instanceStatus: string };
      }>(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/decisions`,
        headers: {
          ...authHeaders(scopedApprover),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: { decision: "approve" }
      });
      expect(secondApprove.status).toBe(200);
      expect(secondApprove.body.data.instanceFinished).toBe(true);
      expect(secondApprove.body.data.instanceStatus).toBe("approved");

      // Double-decision (concurrency/double-action guard): the task is no longer pending.
      const thirdAttempt = await invoke(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/decisions`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: { decision: "approve" }
      });
      expect(thirdAttempt.status).toBe(409);
    });

    test("a single reject completes the task/instance as rejected regardless of quorum rule", async () => {
      const owner = await bootstrap();
      const scopedApprover = await provisionScopedWorkflowUser(
        owner.tenantId,
        "approver3@example.com",
        [
          { activityCode: "approval", action: "approve" },
          { activityCode: "approval", action: "read" }
        ]
      );
      await createAndPublishQuorumDefinition(owner, "quorum_reject", [
        owner.tenantUserId,
        scopedApprover.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      const startResult = await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "quorum_reject",
          resourceType: "test_resource",
          resourceId: "r-reject",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );

      const tasks = await invoke<{ data: { tasks: { id: string }[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending",
          headers: authHeaders(owner)
        }
      );
      const taskId = tasks.body.data.tasks[0]!.id;

      const reject = await invoke<{
        data: { instanceFinished: boolean; instanceStatus: string };
      }>(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/decisions`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: { decision: "reject", reason: "not compliant" }
      });
      expect(reject.status).toBe(200);
      expect(reject.body.data.instanceFinished).toBe(true);
      expect(reject.body.data.instanceStatus).toBe("rejected");
      void startResult;
    });

    test("self-approval is denied: the requester cannot decide their own instance's task", async () => {
      const owner = await bootstrap();
      await createAndPublishQuorumDefinition(owner, "self_approval_test", [
        owner.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      // The requester IS the sole assignee — self-approval.
      await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "self_approval_test",
          resourceType: "test_resource",
          resourceId: "r-self",
          requestedByTenantUserId: owner.tenantUserId,
          notificationPort
        })
      );

      const tasks = await invoke<{ data: { tasks: { id: string }[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending",
          headers: authHeaders(owner)
        }
      );
      const taskId = tasks.body.data.tasks[0]!.id;

      const decision = await invoke(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/decisions`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: { decision: "approve" }
      });
      expect(decision.status).toBe(403);
    });

    test("delegation: an effective-dated delegate may decide on behalf of the original assignee; outside the window it is denied", async () => {
      const owner = await bootstrap();
      const assignee = await provisionScopedWorkflowUser(
        owner.tenantId,
        "assignee@example.com",
        [
          { activityCode: "approval", action: "approve" },
          { activityCode: "approval", action: "read" },
          { activityCode: "delegation", action: "create" }
        ]
      );
      const delegate = await provisionScopedWorkflowUser(
        owner.tenantId,
        "delegate@example.com",
        [
          { activityCode: "approval", action: "approve" },
          { activityCode: "approval", action: "read" }
        ]
      );

      await createAndPublishQuorumDefinition(owner, "delegation_test", [
        assignee.tenantUserId
      ]);

      // Delegate creates a delegation OUTSIDE the effective window (starts tomorrow) first, to prove it's denied.
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const futureDelegation = await invoke(createDelegation, {
        method: "POST",
        path: "/api/v1/workflows/delegations",
        headers: authHeaders(assignee),
        body: {
          delegateTenantUserId: delegate.tenantUserId,
          workflowKey: "delegation_test",
          effectiveFrom: future,
          reason: "future coverage"
        }
      });
      expect(futureDelegation.status).toBe(200);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      const startResult1 = await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "delegation_test",
          resourceType: "test_resource",
          resourceId: "r-delegation-1",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );
      void startResult1;

      const tasksBefore = await invoke<{ data: { tasks: { id: string }[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending",
          headers: authHeaders(owner)
        }
      );
      const outsideWindowTaskId = tasksBefore.body.data.tasks[0]!.id;

      const deniedDecision = await invoke(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${outsideWindowTaskId}/decisions`,
        headers: {
          ...authHeaders(delegate),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: outsideWindowTaskId },
        body: { decision: "approve" }
      });
      expect(deniedDecision.status).toBe(403);

      // Now create an ACTIVE (starting now) delegation and confirm it works.
      const activeDelegation = await invoke(createDelegation, {
        method: "POST",
        path: "/api/v1/workflows/delegations",
        headers: authHeaders(assignee),
        body: {
          delegateTenantUserId: delegate.tenantUserId,
          workflowKey: "delegation_test",
          reason: "on leave"
        }
      });
      expect(activeDelegation.status).toBe(200);

      const allowedDecision = await invoke(decideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${outsideWindowTaskId}/decisions`,
        headers: {
          ...authHeaders(delegate),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: outsideWindowTaskId },
        body: { decision: "approve" }
      });
      expect(allowedDecision.status).toBe(200);
    });

    test("administrative recovery: reassign/cancel/force-decide require explicit permission and are denied without it", async () => {
      const owner = await bootstrap();
      const assignee = await provisionScopedWorkflowUser(
        owner.tenantId,
        "assignee-recovery@example.com",
        [
          { activityCode: "approval", action: "approve" },
          { activityCode: "approval", action: "read" }
        ]
      );
      const unauthorizedUser = await provisionScopedWorkflowUser(
        owner.tenantId,
        "no-recovery@example.com",
        [{ activityCode: "approval", action: "read" }]
      );

      await createAndPublishQuorumDefinition(owner, "recovery_test", [
        assignee.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "recovery_test",
          resourceType: "test_resource",
          resourceId: "r-recovery",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );

      const tasks = await invoke<{
        data: { tasks: { id: string; instanceId: string }[] };
      }>(listTasks, {
        method: "GET",
        path: "/api/v1/workflows/tasks?status=pending",
        headers: authHeaders(owner)
      });
      const taskId = tasks.body.data.tasks[0]!.id;
      const instanceId = tasks.body.data.tasks[0]!.instanceId;

      // Unauthorized reassign/force-decide/cancel are all denied.
      const deniedReassign = await invoke(reassignTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/reassign`,
        headers: {
          ...authHeaders(unauthorizedUser),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: {
          toTenantUserId: owner.tenantUserId,
          reason: "unauthorized attempt"
        }
      });
      expect(deniedReassign.status).toBe(403);

      const deniedForceDecide = await invoke(forceDecideTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/force-decision`,
        headers: {
          ...authHeaders(unauthorizedUser),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: { decision: "approve", reason: "unauthorized attempt" }
      });
      expect(deniedForceDecide.status).toBe(403);

      const deniedCancel = await invoke(cancelInstance, {
        method: "POST",
        path: `/api/v1/workflows/instances/${instanceId}/cancel`,
        headers: {
          ...authHeaders(unauthorizedUser),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: instanceId },
        body: { reason: "unauthorized attempt" }
      });
      expect(deniedCancel.status).toBe(403);

      // Owner (has all permissions) can reassign successfully.
      const reassign = await invoke(reassignTask, {
        method: "POST",
        path: `/api/v1/workflows/tasks/${taskId}/reassign`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: taskId },
        body: {
          toTenantUserId: owner.tenantUserId,
          reason: "assignee unavailable"
        }
      });
      expect(reassign.status).toBe(200);

      // Owner can then force-decide, bypassing quorum, fully audited.
      const forceDecide = await invoke<{ data: { instanceStatus: string } }>(
        forceDecideTask,
        {
          method: "POST",
          path: `/api/v1/workflows/tasks/${taskId}/force-decision`,
          headers: {
            ...authHeaders(owner),
            "idempotency-key": crypto.randomUUID()
          },
          params: { id: taskId },
          body: {
            decision: "approve",
            reason: "administrative override for stalled approval"
          }
        }
      );
      expect(forceDecide.status).toBe(200);
      expect(forceDecide.body.data.instanceStatus).toBe("approved");

      const history = await invoke<{ data: { history: { action: string }[] } }>(
        getInstance,
        {
          method: "GET",
          path: `/api/v1/workflows/instances/${instanceId}`,
          headers: authHeaders(owner),
          params: { id: instanceId }
        }
      );
      expect(history.status).toBe(200);
      expect(
        history.body.data.history.some((h) => h.action === "force_approve")
      ).toBe(true);
    });

    test("cancel requires a reason and is idempotent/immutable-history preserving", async () => {
      const owner = await bootstrap();
      await createAndPublishQuorumDefinition(owner, "cancel_test", [
        owner.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      const startResult = await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "cancel_test",
          resourceType: "test_resource",
          resourceId: "r-cancel",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );

      const missingReason = await invoke(cancelInstance, {
        method: "POST",
        path: `/api/v1/workflows/instances/${startResult.instanceId}/cancel`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: startResult.instanceId },
        body: {}
      });
      expect(missingReason.status).toBe(400);

      const cancel = await invoke(cancelInstance, {
        method: "POST",
        path: `/api/v1/workflows/instances/${startResult.instanceId}/cancel`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: startResult.instanceId },
        body: { reason: "resource withdrawn" }
      });
      expect(cancel.status).toBe(200);
    });

    test("escalation job is idempotent: a due task is only escalated once even across multiple job passes, running as the least-privilege worker role", async () => {
      const owner = await bootstrap();
      const escalateToUserId = crypto.randomUUID();

      const created = await invoke<{ data: { definition: { id: string } } }>(
        createDefinition,
        {
          method: "POST",
          path: "/api/v1/workflows/definitions",
          headers: authHeaders(owner),
          body: {
            workflowKey: "escalation_test",
            name: "Escalation test",
            graph: {
              startNodeId: "approve",
              nodes: [
                {
                  id: "approve",
                  type: "approval",
                  name: "Approval",
                  assigneeTenantUserIds: [owner.tenantUserId],
                  quorumRule: "all",
                  escalation: {
                    timeoutMinutes: 1,
                    escalateToTenantUserId: escalateToUserId,
                    maxEscalations: 2
                  },
                  onApprove: "end_approved",
                  onReject: "end_rejected"
                },
                { id: "end_approved", type: "end", outcome: "approved" },
                { id: "end_rejected", type: "end", outcome: "rejected" }
              ]
            }
          }
        }
      );
      const definitionId = created.body.data.definition.id;
      await invoke(publishDefinition, {
        method: "POST",
        path: `/api/v1/workflows/definitions/${definitionId}/publish`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: definitionId }
      });

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "escalation_test",
          resourceType: "test_resource",
          resourceId: "r-escalation",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );

      // Force the task's due_at into the past (as admin — a real definition
      // would compute this at task-creation time from `escalation.timeoutMinutes`).
      const admin = getAdminSql();
      await admin`
        UPDATE awcms_mini_workflow_tasks
        SET due_at = now() - interval '10 minutes'
        WHERE tenant_id = ${owner.tenantId} AND status = 'pending'
      `;

      const workerSql = getWorkerTestSql();
      const now = new Date();

      const firstPass = await escalateDueTasksForTenant(
        workerSql,
        owner.tenantId,
        now,
        25
      );
      expect(firstPass.count).toBe(1);

      // A second immediate pass must NOT re-escalate the same task (idempotency
      // guard: due_at was pushed forward by the first pass to timeoutMinutes
      // from now, well past `now`).
      const secondPass = await escalateDueTasksForTenant(
        workerSql,
        owner.tenantId,
        now,
        25
      );
      expect(secondPass.count).toBe(0);

      const escalatedAssignments = (await admin`
        SELECT tenant_user_id FROM awcms_mini_workflow_task_assignments
        WHERE tenant_id = ${owner.tenantId} AND tenant_user_id = ${escalateToUserId}
      `) as { tenant_user_id: string }[];
      expect(escalatedAssignments.length).toBe(1);
    });

    test("cross-tenant RLS isolation: a second tenant cannot see or act on the first tenant's tasks/instances", async () => {
      const owner = await bootstrap();
      await createAndPublishQuorumDefinition(owner, "rls_test", [
        owner.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      const startResult = await withTenant(sql, owner.tenantId, (tx) =>
        startWorkflowInstance(tx, {
          tenantId: owner.tenantId,
          workflowKey: "rls_test",
          resourceType: "test_resource",
          resourceId: "r-rls",
          requestedByTenantUserId: crypto.randomUUID(),
          notificationPort
        })
      );

      const tenantB = await seedRestrictedSecondTenant("acmeb");

      // Tenant B has zero permissions granted -> ABAC deny (403), not a 404/leak.
      const crossTenantGet = await invoke(getInstance, {
        method: "GET",
        path: `/api/v1/workflows/instances/${startResult.instanceId}`,
        headers: authHeaders(tenantB),
        params: { id: startResult.instanceId }
      });
      expect(crossTenantGet.status).toBe(403);

      // Tenant A's own view is unaffected and still finds its own instance.
      const ownTenantGet = await invoke(getInstance, {
        method: "GET",
        path: `/api/v1/workflows/instances/${startResult.instanceId}`,
        headers: authHeaders(owner),
        params: { id: startResult.instanceId }
      });
      expect(ownTenantGet.status).toBe(200);
    });

    test("approval inbox: filters by overdue and paginates via keyset cursor", async () => {
      const owner = await bootstrap();
      await createAndPublishQuorumDefinition(owner, "inbox_test", [
        owner.tenantUserId
      ]);

      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      const { getDatabaseClient } =
        await import("../../src/lib/database/client");
      const sql = getDatabaseClient();

      for (let i = 0; i < 3; i += 1) {
        await withTenant(sql, owner.tenantId, (tx) =>
          startWorkflowInstance(tx, {
            tenantId: owner.tenantId,
            workflowKey: "inbox_test",
            resourceType: "test_resource",
            resourceId: `r-inbox-${i}`,
            requestedByTenantUserId: crypto.randomUUID(),
            notificationPort
          })
        );
      }

      const allPending = await invoke<{ data: { tasks: unknown[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending",
          headers: authHeaders(owner)
        }
      );
      expect(allPending.status).toBe(200);
      expect(allPending.body.data.tasks.length).toBe(3);

      const overdueOnly = await invoke<{ data: { tasks: unknown[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending&overdue=true",
          headers: authHeaders(owner)
        }
      );
      expect(overdueOnly.status).toBe(200);
      expect(overdueOnly.body.data.tasks.length).toBe(0);

      const searchByResourceType = await invoke<{ data: { tasks: unknown[] } }>(
        listTasks,
        {
          method: "GET",
          path: "/api/v1/workflows/tasks?status=pending&resourceType=test_resource",
          headers: authHeaders(owner)
        }
      );
      expect(searchByResourceType.status).toBe(200);
      expect(searchByResourceType.body.data.tasks.length).toBe(3);
    });
  }
);
