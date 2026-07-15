import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { unlinkDocumentFromResource } from "../../../../../../../modules/document-infrastructure/application/document-resource-relation-port";
import {
  CONFIDENTIAL_READ_PERMISSION_KEY,
  RESTRICTED_READ_PERMISSION_KEY
} from "../../../../../../../modules/document-infrastructure/domain/document";

const IDEMPOTENCY_SCOPE = "document_infrastructure_relation_unlink";

const REVOKE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "relations",
  action: "revoke" as const
};

/** `DELETE /api/v1/document-infrastructure/documents/{id}/relations/{relationId}` (Issue #751) — unlinks a document from a resource. High-risk mutation (`revoke`): requires `Idempotency-Key`. `{id}` (document id) is accepted for URL symmetry with the parent resource but not otherwise used — `relationId` alone (tenant-scoped) is sufficient to locate the row. */
export const DELETE: APIRoute = async ({
  request,
  cookies,
  params,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const relationId = params.relationId;
  if (!relationId)
    return fail(400, "VALIDATION_ERROR", "Relation id is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{ reason?: unknown }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const reason = typeof body.reason === "string" ? body.reason : "";

  const requestHash = computeRequestHash({
    ...body,
    relationId,
    action: "unlink"
  });
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

    // Confidentiality-tier clearance on the PARENT document (Issue #787
    // fast-follow) — resolved inside `unlinkDocumentFromResource` itself
    // (only a bare `relationId` reaches this route), see that function's
    // doc comment.
    const access = {
      canReadConfidential: auth.grantedPermissionKeys.has(
        CONFIDENTIAL_READ_PERMISSION_KEY
      ),
      canReadRestricted: auth.grantedPermissionKeys.has(
        RESTRICTED_READ_PERMISSION_KEY
      )
    };

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

    const result = await unlinkDocumentFromResource(
      tx,
      tenantId,
      auth.context.tenantUserId,
      relationId,
      reason,
      access,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Relation not found.");
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ relation: result.relation });
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
