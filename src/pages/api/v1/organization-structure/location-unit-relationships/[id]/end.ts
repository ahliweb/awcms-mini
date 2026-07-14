import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { endLocationUnitRelationship } from "../../../../../../modules/organization-structure/application/location-unit-relationship-service";

const IDEMPOTENCY_SCOPE =
  "organization_structure_location_unit_relationship_end";

const REVOKE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "location_unit_relationships",
  action: "revoke" as const
};

/** `POST /api/v1/organization-structure/location-unit-relationships/{id}/end` (Issue #749). High-risk mutation: requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const relationshipId = params.id;
  if (!relationshipId)
    return fail(400, "VALIDATION_ERROR", "Relationship id is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const requestHash = computeRequestHash({});
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
      REVOKE_GUARD
    );
    if (!auth.allowed) return auth.denied;

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

    const result = await endLocationUnitRelationship(
      tx,
      tenantId,
      auth.context.tenantUserId,
      relationshipId,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(
          404,
          "NOT_FOUND",
          "Location-to-unit relationship not found."
        );
      return fail(
        409,
        "ALREADY_ENDED",
        "Location-to-unit relationship has already ended."
      );
    }

    const successResponse = ok({ relationship: result.relationship });
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
  });
};
