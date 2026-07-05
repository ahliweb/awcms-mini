import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../../modules/identity-access/domain/access-control";

const GUARD_REQUEST = {
  moduleKey: "workflow",
  activityCode: "approval",
  action: "read" as const
};

const PENDING_TASK_LIMIT = 100;

type PendingTaskRow = {
  id: string;
  step_order: number;
  created_at: Date;
  instance_id: string;
  resource_type: string;
  resource_id: string;
  requested_by_tenant_user_id: string;
  current_step_order: number;
  definition_id: string;
  workflow_key: string;
  definition_name: string;
};

/**
 * `GET /api/v1/workflows/tasks` (Issue 11.1). Bearer-session auth, guarded by
 * `workflow.approval.read`. Lists this tenant's pending tasks joined with
 * their instance and definition for context. There is no public
 * create-definition/start-instance endpoint in this base (doc 17's seed
 * model grants no `create`/`configure` action for `workflow.approval`) — see
 * `src/modules/workflow-approval/README.md`.
 */
export const GET: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

      if (!context) {
        return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
      }

      const grantedPermissionKeys = await fetchGrantedPermissionKeys(
        tx,
        tenantId,
        context.tenantUserId
      );
      const decision = evaluateAccess(
        context,
        GUARD_REQUEST,
        grantedPermissionKeys
      );

      await recordDecisionLog(
        tx,
        tenantId,
        context.tenantUserId,
        GUARD_REQUEST,
        decision
      );

      if (!decision.allowed) {
        return fail(403, "ACCESS_DENIED", decision.reason);
      }

      const rows = (await tx`
        SELECT t.id, t.step_order, t.created_at,
               i.id AS instance_id, i.resource_type, i.resource_id,
               i.requested_by_tenant_user_id, i.current_step_order,
               d.id AS definition_id, d.workflow_key, d.name AS definition_name
        FROM awcms_mini_workflow_tasks t
        JOIN awcms_mini_workflow_instances i ON i.id = t.workflow_instance_id
        JOIN awcms_mini_workflow_definitions d ON d.id = i.workflow_definition_id
        WHERE t.tenant_id = ${tenantId} AND t.status = 'pending'
        ORDER BY t.created_at ASC
        LIMIT ${PENDING_TASK_LIMIT}
      `) as PendingTaskRow[];

      return ok({
        tasks: rows.map((row) => ({
          id: row.id,
          stepOrder: Number(row.step_order),
          createdAt: row.created_at.toISOString(),
          instanceId: row.instance_id,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          requestedByTenantUserId: row.requested_by_tenant_user_id,
          currentStepOrder: Number(row.current_step_order),
          workflowDefinitionId: row.definition_id,
          workflowKey: row.workflow_key,
          workflowName: row.definition_name
        }))
      });
    },
    { workClass: "interactive" }
  );
};
