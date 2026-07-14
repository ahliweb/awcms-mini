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
import { endOrganizationUnitAssignment } from "../../../../../../modules/organization-structure/application/organization-unit-assignment-service";

const REVOKE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "assignments",
  action: "revoke" as const
};

/** `POST /api/v1/organization-structure/assignments/{id}/end` (Issue #749) — end an active assignment. `endReason` required. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const assignmentId = params.id;
  if (!assignmentId)
    return fail(400, "VALIDATION_ERROR", "Assignment id is required.");

  const bodyRead = await readJsonBody<{ endReason?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const endReason = typeof body.endReason === "string" ? body.endReason : "";

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

    const result = await endOrganizationUnitAssignment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      assignmentId,
      { endReason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(
          404,
          "NOT_FOUND",
          "Organization-unit assignment not found."
        );
      if (result.reason === "already_ended")
        return fail(409, "ALREADY_ENDED", "Assignment has already ended.");
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    return ok({ assignment: result.assignment });
  });
};
