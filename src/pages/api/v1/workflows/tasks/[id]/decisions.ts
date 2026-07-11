import type { APIRoute } from "astro";
import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { extractBearerToken } from "../../../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../../../modules/identity-access/domain/access-control";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import {
  evaluateDecisionOutcome,
  validateWorkflowDecisionRequestBody
} from "../../../../../../modules/workflow-approval/domain/workflow-transition";

const GUARD_ACTIVITY = { moduleKey: "workflow", activityCode: "approval" };
const IDEMPOTENCY_SCOPE = "workflow_task_decision";

type TaskWithInstanceRow = {
  id: string;
  status: string;
  step_order: number;
  instance_id: string;
  instance_status: string;
  current_step_order: number;
  requested_by_tenant_user_id: string;
  steps: unknown;
};

/**
 * `POST /api/v1/workflows/tasks/{id}/decisions` (Issue 11.1). Bearer-session
 * auth, guarded by `workflow.approval.approve` (same action for both
 * "approve" and "reject" decisions — the permission is the ability to
 * decide, matching the existing `sync_storage.conflict_resolution.approve`
 * precedent used for `POST /sync/conflicts/{id}/resolve`).
 *
 * The task's instance's `requested_by_tenant_user_id` is looked up BEFORE
 * calling `evaluateAccess` so the existing generic self-approval guard in
 * `src/modules/identity-access/domain/access-control.ts` (added in Issue 2.4,
 * reused here unchanged) has the right value to compare against
 * `context.tenantUserId`.
 *
 * High-risk mutation: requires `Idempotency-Key` (doc 10 §Idempotency wrapper
 * rules explicitly lists "workflow decision"). Same key + same request body
 * hash replays the stored response; same key + different hash ->
 * `409 IDEMPOTENCY_CONFLICT`.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  const taskId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!taskId) {
    return fail(400, "VALIDATION_ERROR", "Task id is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const idempotencyKey = request.headers.get("idempotency-key");

  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateWorkflowDecisionRequestBody(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Decision input is invalid.",
      {},
      validation.errors
    );
  }

  const { decision, reason } = validation.value;
  const requestHash = computeRequestHash({ taskId, decision, reason });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

      if (!context) {
        return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
      }

      const taskRows = (await tx`
        SELECT t.id, t.status, t.step_order,
               i.id AS instance_id, i.status AS instance_status, i.current_step_order,
               i.requested_by_tenant_user_id, d.steps
        FROM awcms_mini_workflow_tasks t
        JOIN awcms_mini_workflow_instances i ON i.id = t.workflow_instance_id
        JOIN awcms_mini_workflow_definitions d ON d.id = i.workflow_definition_id
        WHERE t.tenant_id = ${tenantId} AND t.id = ${taskId}
      `) as TaskWithInstanceRow[];
      const task = taskRows[0];

      const guardRequest = {
        ...GUARD_ACTIVITY,
        action: "approve" as const,
        resourceType: "workflow_task",
        resourceId: taskId,
        resourceAttributes: {
          tenantId,
          requestedByTenantUserId: task?.requested_by_tenant_user_id
        }
      };

      const decisionResult = evaluateAccess(
        context,
        guardRequest,
        await fetchGrantedPermissionKeys(tx, tenantId, context.tenantUserId)
      );

      await recordDecisionLog(
        tx,
        tenantId,
        context.tenantUserId,
        guardRequest,
        decisionResult
      );

      if (!decisionResult.allowed) {
        return fail(403, "ACCESS_DENIED", decisionResult.reason);
      }

      const existingIdempotency = await findIdempotencyRecord(
        tx,
        tenantId,
        IDEMPOTENCY_SCOPE,
        idempotencyKey
      );

      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== requestHash) {
          return fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different request."
          );
        }

        return jsonResponse(existingIdempotency.responseBody, {
          status: existingIdempotency.responseStatus
        });
      }

      if (!task) {
        return fail(404, "RESOURCE_NOT_FOUND", "Workflow task not found.");
      }

      if (task.status !== "pending") {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Task decision has already been recorded."
        );
      }

      await tx`
        INSERT INTO awcms_mini_workflow_decisions
          (tenant_id, workflow_task_id, decision, decided_by_tenant_user_id, reason)
        VALUES (${tenantId}, ${taskId}, ${decision}, ${context.tenantUserId}, ${reason ?? null})
      `;

      await tx`
        UPDATE awcms_mini_workflow_tasks
        SET status = 'completed'
        WHERE tenant_id = ${tenantId} AND id = ${taskId}
      `;

      const totalSteps = Array.isArray(task.steps) ? task.steps.length : 0;
      const currentStepOrder = Number(task.current_step_order);
      const outcome = evaluateDecisionOutcome({
        decision,
        currentStepOrder,
        totalSteps
      });

      await tx`
        UPDATE awcms_mini_workflow_instances
        SET status = ${outcome.instanceStatus},
            current_step_order = ${outcome.nextStepOrder ?? currentStepOrder},
            updated_at = ${now}
        WHERE tenant_id = ${tenantId} AND id = ${task.instance_id}
      `;

      if (outcome.nextStepOrder !== null) {
        await tx`
          INSERT INTO awcms_mini_workflow_tasks
            (tenant_id, workflow_instance_id, step_order, status)
          VALUES (${tenantId}, ${task.instance_id}, ${outcome.nextStepOrder}, 'pending')
        `;
      }

      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId: context.tenantUserId,
        moduleKey: "workflow",
        action: decision,
        resourceType: "workflow_instance",
        resourceId: task.instance_id,
        severity: "warning",
        message: `Workflow task decision recorded: ${decision}.`,
        attributes: { decision, reason },
        correlationId
      });

      const responseData = {
        taskId,
        decision,
        instanceId: task.instance_id,
        instanceStatus: outcome.instanceStatus,
        nextStepOrder: outcome.nextStepOrder
      };
      const successResponse = ok(responseData);
      const successBody = await successResponse.clone().json();

      await saveIdempotencyRecord(
        tx,
        tenantId,
        IDEMPOTENCY_SCOPE,
        idempotencyKey,
        requestHash,
        200,
        successBody
      );

      return successResponse;
    },
    { workClass: "interactive" }
  );
};
