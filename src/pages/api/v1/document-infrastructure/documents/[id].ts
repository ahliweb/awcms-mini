import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import {
  deleteDocument,
  fetchDocumentById,
  updateDocumentMetadata
} from "../../../../../modules/document-infrastructure/application/document-directory";
import {
  CONFIDENTIAL_READ_PERMISSION_KEY,
  RESTRICTED_READ_PERMISSION_KEY
} from "../../../../../modules/document-infrastructure/domain/document";

const IDEMPOTENCY_SCOPE = "document_infrastructure_document_delete";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "documents",
  action: "read" as const
};

const UPDATE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "documents",
  action: "update" as const
};

const DELETE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "documents",
  action: "delete" as const
};

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

    // Confidentiality-tier clearance (Issue #751 security-review Critical
    // finding) — see `documents/index.ts`'s identical comment.
    const access = {
      canReadConfidential: auth.grantedPermissionKeys.has(
        CONFIDENTIAL_READ_PERMISSION_KEY
      ),
      canReadRestricted: auth.grantedPermissionKeys.has(
        RESTRICTED_READ_PERMISSION_KEY
      )
    };

    const document = await fetchDocumentById(tx, tenantId, documentId, access);
    if (!document) {
      // Deliberately identical to "genuinely does not exist" — never
      // confirms a confidential/restricted document's existence to a
      // caller who lacks clearance for it (see `fetchDocumentById`'s own
      // doc comment).
      return fail(404, "NOT_FOUND", "Document not found.");
    }
    return ok({ document });
  });
};

/** Not idempotent (low-risk metadata update — title/summary/dates only, same class as `organization-structure/legal-entities` PATCH). */
export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const documentId = params.id;
  if (!documentId)
    return fail(400, "VALIDATION_ERROR", "Document id is required.");

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    title: typeof body.title === "string" ? body.title : "",
    summary: typeof body.summary === "string" ? body.summary : null,
    issuedAt:
      typeof body.issuedAt === "string" ? new Date(body.issuedAt) : null,
    effectiveAt:
      typeof body.effectiveAt === "string" ? new Date(body.effectiveAt) : null
  };

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
    if (!auth.allowed) return auth.denied;

    const result = await updateDocumentMetadata(
      tx,
      tenantId,
      auth.context.tenantUserId,
      documentId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Document not found.");
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    return ok({ document: result.document });
  });
};

/** `DELETE /api/v1/document-infrastructure/documents/{id}` — soft-delete a mistakenly created registry entry (distinct from `void`, see `sql/067`'s header). High-risk mutation: requires `Idempotency-Key`. */
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

  const bodyRead = await readJsonBody<{ deleteReason?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const deleteReason =
    typeof body.deleteReason === "string" ? body.deleteReason : "";

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
      DELETE_GUARD
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

    const result = await deleteDocument(
      tx,
      tenantId,
      auth.context.tenantUserId,
      documentId,
      { deleteReason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Document not found.");
      }
      if (result.reason === "already_deleted") {
        return fail(409, "ALREADY_DELETED", "Document is already deleted.");
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
