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
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { reclassifyDocument } from "../../../../../../modules/document-infrastructure/application/document-directory";
import {
  CONFIDENTIAL_READ_PERMISSION_KEY,
  RESTRICTED_READ_PERMISSION_KEY
} from "../../../../../../modules/document-infrastructure/domain/document";

const IDEMPOTENCY_SCOPE = "document_infrastructure_document_reclassify";

const RECLASSIFY_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "documents",
  action: "reclassify" as const
};

/** `POST /api/v1/document-infrastructure/documents/{id}/reclassify` (Issue #751) — changes classification/confidentiality level, security-sensitive since it can widen who is allowed to read the document. High-risk mutation: requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const documentId = params.id;
  if (!documentId)
    return fail(400, "VALIDATION_ERROR", "Document id is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{
    classificationId?: unknown;
    confidentialityLevel?: unknown;
    reason?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    classificationId:
      typeof body.classificationId === "string" ? body.classificationId : null,
    confidentialityLevel:
      typeof body.confidentialityLevel === "string"
        ? body.confidentialityLevel
        : "",
    reason: typeof body.reason === "string" ? body.reason : ""
  };

  const requestHash = computeRequestHash(body);
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
      RECLASSIFY_GUARD
    );
    if (!auth.allowed) return auth.denied;

    // Confidentiality-tier clearance (Issue #787 fast-follow) — checked
    // against the CURRENT confidentiality level before the change is
    // applied; see `document-directory.ts`'s `reclassifyDocument` doc
    // comment.
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

    const result = await reclassifyDocument(
      tx,
      tenantId,
      auth.context.tenantUserId,
      documentId,
      input,
      access,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Document not found.");
      }
      if (result.reason === "classification_not_found") {
        return fail(
          422,
          "CLASSIFICATION_INVALID",
          "classificationId does not reference an existing classification for this tenant."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ document: result.document });
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
