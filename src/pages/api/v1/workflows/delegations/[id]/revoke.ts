import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  revokeWorkflowDelegation,
  WorkflowDelegationForbiddenError,
  WorkflowDelegationNotFoundError
} from "../../../../../../modules/workflow-approval/application/workflow-delegation-directory";

/**
 * Read-only guard (`workflow.delegation.read`) is intentionally NOT what
 * gates this route — `revokeWorkflowDelegation` itself enforces "only the
 * delegator may revoke their own delegation" (an ownership check, not a
 * permission check). A caller who separately holds
 * `workflow.recovery.cancel`-equivalent administrative authority is out of
 * scope for this issue's revoke path (Issue #747 explicitly scopes
 * delegation revocation to "revocable" by the delegator; a future
 * administrative-override revoke would be a distinct, explicitly
 * permissioned action). We still require the caller to be an
 * authenticated tenant user with the `delegation.read` permission at
 * minimum, so an entirely unauthorized caller cannot even reach the
 * ownership check.
 */
const READ_GUARD = {
  moduleKey: "workflow",
  activityCode: "delegation",
  action: "read" as const
};
const MAX_REASON_LENGTH = 500;

type RevokeRequestBody = { reason?: unknown };

export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Delegation id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const bodyRead = await readJsonBody<RevokeRequestBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const reason =
    typeof bodyRead.value?.reason === "string"
      ? bodyRead.value.reason.trim()
      : undefined;

  if (reason !== undefined && reason.length > MAX_REASON_LENGTH) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `reason must be at most ${MAX_REASON_LENGTH} characters.`
    );
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const auth = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        READ_GUARD
      );
      if (!auth.allowed) return auth.denied;

      try {
        const revoked = await revokeWorkflowDelegation(tx, {
          tenantId,
          delegationId: id,
          revokedByTenantUserId: auth.context.tenantUserId,
          revokeReason: reason,
          correlationId: locals.correlationId
        });

        return ok(
          { id: revoked.id, status: revoked.status },
          { correlationId: locals.correlationId }
        );
      } catch (error) {
        if (error instanceof WorkflowDelegationNotFoundError) {
          return fail(404, "RESOURCE_NOT_FOUND", error.message);
        }
        if (error instanceof WorkflowDelegationForbiddenError) {
          return fail(403, "ACCESS_DENIED", error.message);
        }
        throw error;
      }
    },
    { workClass: "interactive" }
  );
};
