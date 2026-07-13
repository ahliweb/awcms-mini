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
 *
 * PR #777 review follow-up (Issue #748): a profile that is soft-deleted
 * BECAUSE it was merged away (`merged_into_profile_id IS NOT NULL`,
 * `status = 'merged'`, set by `executeMergeRequest`) must NOT be
 * restorable through this ordinary lifecycle endpoint — its
 * `awcms_mini_profile_entity_links` were already repointed to the
 * survivor and deleted from this profile, so a naive restore would
 * resurrect it as "live" while still carrying stale merge lineage and
 * zero references, and it could never be merged again (`createMergeRequest`
 * rejects any profile with `merged_into_profile_id !== null`). Rejected
 * with `409 PROFILE_RESTORE_BLOCKED_BY_MERGE` — clearing merge lineage to
 * make a merged profile restorable is a deliberately separate, not-yet-built
 * capability (would need its own explicit, audited "unmerge" decision, not
 * a side effect of the ordinary restore endpoint).
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
      SELECT id, deleted_at, merged_into_profile_id FROM awcms_mini_profiles
      WHERE tenant_id = ${tenantId} AND id = ${profileId}
    `;
    const profile = profileRows[0] as
      | {
          id: string;
          deleted_at: Date | null;
          merged_into_profile_id: string | null;
        }
      | undefined;

    if (!profile || profile.deleted_at === null) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "Profile not found or not currently soft-deleted."
      );
    }

    if (profile.merged_into_profile_id !== null) {
      return fail(
        409,
        "PROFILE_RESTORE_BLOCKED_BY_MERGE",
        "Profile was merged away and cannot be restored through this endpoint; its references were already repointed to the survivor."
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
