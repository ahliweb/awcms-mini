import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../../../modules/identity-access/domain/access-control";
import { validateConflictResolutionRequestBody } from "../../../../../../modules/sync-storage/domain/sync-validation";

const GUARD_REQUEST = {
  moduleKey: "sync_storage",
  activityCode: "conflict_resolution",
  action: "approve" as const
};

export const POST: APIRoute = async ({ request, params }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  const conflictId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!conflictId) {
    return fail(400, "VALIDATION_ERROR", "Conflict id is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const body = await request.json().catch(() => null);
  const validation = validateConflictResolutionRequestBody(body);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Conflict resolution input is invalid.",
      {},
      validation.errors
    );
  }

  const { resolution, note } = validation.value;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
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

    const conflictRows = await tx`
      SELECT id, status FROM awcms_mini_sync_conflicts
      WHERE tenant_id = ${tenantId} AND id = ${conflictId}
    `;
    const conflict = conflictRows[0] as
      { id: string; status: string } | undefined;

    if (!conflict) {
      return fail(404, "RESOURCE_NOT_FOUND", "Conflict not found.");
    }

    if (conflict.status === "resolved") {
      return fail(409, "IDEMPOTENCY_CONFLICT", "Conflict is already resolved.");
    }

    await tx`
      UPDATE awcms_mini_sync_conflicts
      SET status = 'resolved', resolution = ${resolution}, resolution_note = ${note ?? null},
          resolved_by = ${context.tenantUserId}, resolved_at = ${now}
      WHERE id = ${conflictId}
    `;

    return ok({ id: conflictId, status: "resolved", resolution });
  });
};
