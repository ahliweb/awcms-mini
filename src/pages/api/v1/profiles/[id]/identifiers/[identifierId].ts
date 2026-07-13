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
  softDeleteIdentifier,
  updateIdentifier
} from "../../../../../../modules/profile-identity/application/identifier-directory";
import { validateUpdateIdentifierInput } from "../../../../../../modules/profile-identity/domain/identifier-lifecycle";
import { validateDeleteReasonRequestBody } from "../../../../../../modules/profile-identity/domain/lifecycle-validation";

const UPDATE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "identifiers",
  action: "update" as const
};

const DELETE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "identifiers",
  action: "delete" as const
};

/** `PATCH /api/v1/profiles/{id}/identifiers/{identifierId}` (Issue #748) — verification/preferred flag/validity-window update. */
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;
  const identifierId = params.identifierId;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId || !identifierId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Profile id and identifier id are required."
    );
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateUpdateIdentifierInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Identifier update input is invalid.",
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
      UPDATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const identifier = await updateIdentifier(
      tx,
      tenantId,
      auth.context.tenantUserId,
      profileId,
      identifierId,
      validation.value,
      correlationId
    );

    if (!identifier) {
      return fail(404, "RESOURCE_NOT_FOUND", "Identifier not found.");
    }

    return ok(identifier);
  });
};

/** `DELETE /api/v1/profiles/{id}/identifiers/{identifierId}` (Issue #748) — soft delete. Body `{ reason: string }` required. */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;
  const identifierId = params.identifierId;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId || !identifierId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Profile id and identifier id are required."
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

    const deleted = await softDeleteIdentifier(
      tx,
      tenantId,
      auth.context.tenantUserId,
      profileId,
      identifierId,
      validation.value.reason,
      correlationId
    );

    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Identifier not found.");
    }

    return ok({ id: identifierId, status: "deleted" });
  });
};
