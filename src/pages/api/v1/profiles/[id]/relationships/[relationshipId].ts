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
import { endRelationship } from "../../../../../../modules/profile-identity/application/relationship-directory";

const DELETE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "relationships",
  action: "delete" as const
};

type EndRelationshipBody = { reason?: unknown };

/** `DELETE /api/v1/profiles/{id}/relationships/{relationshipId}` (Issue #748) — ends an active relationship (`status = 'ended'`). Body `{ reason?: string }` optional (unlike identifier/address/channel soft delete, ending a relationship is a point-in-time state transition, not a soft-deleted record — reason is informational, not required). */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;
  const relationshipId = params.relationshipId;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId || !relationshipId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Profile id and relationship id are required."
    );
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<EndRelationshipBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const rawReason = bodyRead.value?.reason;

  if (rawReason !== undefined && typeof rawReason !== "string") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "reason must be a string when provided."
    );
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      DELETE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const ended = await endRelationship(
      tx,
      tenantId,
      auth.context.tenantUserId,
      profileId,
      relationshipId,
      (rawReason as string | undefined)?.trim() || null,
      correlationId
    );

    if (!ended) {
      return fail(404, "RESOURCE_NOT_FOUND", "Active relationship not found.");
    }

    return ok({ id: relationshipId, status: "ended" });
  });
};
