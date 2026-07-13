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
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import { recordCounter } from "../../../../../lib/observability/metrics-port";

const GUARD_REQUEST = {
  moduleKey: "profile_identity",
  activityCode: "profile_management",
  action: "restore" as const
};

/**
 * `POST /api/v1/profiles/{id}/restore` (Issue 10.1). Guarded by the newly
 * added `restore` ABAC action (doc 10 §ABAC guard). Clears
 * `deleted_at`/`deleted_by`/`delete_reason`, sets `restored_at`/`restored_by`.
 * 404 if the profile is not currently soft-deleted.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

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

    const profileRows = await tx`
      SELECT id, deleted_at FROM awcms_mini_profiles
      WHERE tenant_id = ${tenantId} AND id = ${profileId}
    `;
    const profile = profileRows[0] as
      { id: string; deleted_at: Date | null } | undefined;

    if (!profile || profile.deleted_at === null) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "Profile not found or not currently soft-deleted."
      );
    }

    await tx`
      UPDATE awcms_mini_profiles
      SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
          restored_at = ${now}, restored_by = ${context.tenantUserId}, updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${profileId}
    `;

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: context.tenantUserId,
      moduleKey: "profile_identity",
      action: "restore",
      resourceType: "profile",
      resourceId: profileId,
      severity: "warning",
      message: "Profile restored.",
      correlationId
    });

    recordCounter("profile_identity_party_lifecycle_total", {
      action: "restore"
    });

    return ok({ id: profileId, status: "restored" });
  });
};
