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
import {
  linkDocumentToResource,
  listRelationsForDocument
} from "../../../../../../../modules/document-infrastructure/application/document-resource-relation-port";

const IDEMPOTENCY_SCOPE = "document_infrastructure_relation_link";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "relations",
  action: "read" as const
};

const ASSIGN_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "relations",
  action: "assign" as const
};

/** `GET /api/v1/document-infrastructure/documents/{id}/relations` (Issue #751). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const documentId = params.id;
  if (!documentId)
    return fail(400, "VALIDATION_ERROR", "Document id is required.");

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      READ_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const relations = await listRelationsForDocument(tx, tenantId, documentId);
    return ok({ relations });
  });
};

/**
 * `POST /api/v1/document-infrastructure/documents/{id}/relations` (Issue
 * #751) — links the document to a resource owned by ANOTHER (or this
 * same) module through the capability port. High-risk mutation
 * (`assign`): requires `Idempotency-Key`.
 */
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
    ownerModuleKey?: unknown;
    resourceType?: unknown;
    resourceId?: unknown;
    relationType?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    ownerModuleKey:
      typeof body.ownerModuleKey === "string" ? body.ownerModuleKey : "",
    resourceType:
      typeof body.resourceType === "string" ? body.resourceType : "",
    resourceId: typeof body.resourceId === "string" ? body.resourceId : "",
    relationType:
      typeof body.relationType === "string" ? body.relationType : "related_to"
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
      ASSIGN_GUARD
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

    const result = await linkDocumentToResource(
      tx,
      tenantId,
      auth.context.tenantUserId,
      documentId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "document_not_found") {
        return fail(404, "NOT_FOUND", "Document not found.");
      }
      if (result.reason === "already_linked") {
        return fail(
          409,
          "ALREADY_LINKED",
          "This document is already linked to that resource with the same relation type."
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
