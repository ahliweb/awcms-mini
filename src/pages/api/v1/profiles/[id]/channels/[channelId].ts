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
import { softDeleteChannel } from "../../../../../../modules/profile-identity/application/channel-directory";
import { validateDeleteReasonRequestBody } from "../../../../../../modules/profile-identity/domain/lifecycle-validation";

const DELETE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "channels",
  action: "delete" as const
};

/** `DELETE /api/v1/profiles/{id}/channels/{channelId}` (Issue #748) — soft delete. Body `{ reason: string }` required. */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;
  const channelId = params.channelId;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId || !channelId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Profile id and channel id are required."
    );
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateDeleteReasonRequestBody(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Delete reason input is invalid.",
      {},
      validation.errors
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

    const deleted = await softDeleteChannel(
      tx,
      tenantId,
      auth.context.tenantUserId,
      profileId,
      channelId,
      validation.value.reason,
      correlationId
    );

    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Channel not found.");
    }

    return ok({ id: channelId, status: "deleted" });
  });
};
