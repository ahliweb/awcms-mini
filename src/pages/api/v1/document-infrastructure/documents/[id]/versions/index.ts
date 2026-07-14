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
  createDocumentVersion,
  listDocumentVersions
} from "../../../../../../../modules/document-infrastructure/application/document-version-service";

const IDEMPOTENCY_SCOPE = "document_infrastructure_version_create";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "versions",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "versions",
  action: "create" as const
};

/** `GET /api/v1/document-infrastructure/documents/{id}/versions` (Issue #751). */
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

    const versions = await listDocumentVersions(tx, tenantId, documentId);
    return ok({ versions });
  });
};

/**
 * `POST /api/v1/document-infrastructure/documents/{id}/versions` (Issue
 * #751) — creates a new IMMUTABLE, append-only version. High-risk
 * mutation: requires `Idempotency-Key` (a network retry must never
 * create two versions for the same upload).
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
    contentReference?: unknown;
    contentReferenceKind?: unknown;
    mediaType?: unknown;
    sizeBytes?: unknown;
    checksumSha256?: unknown;
    source?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    contentReference:
      typeof body.contentReference === "string" ? body.contentReference : "",
    contentReferenceKind:
      typeof body.contentReferenceKind === "string"
        ? body.contentReferenceKind
        : "",
    mediaType: typeof body.mediaType === "string" ? body.mediaType : "",
    sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : -1,
    checksumSha256:
      typeof body.checksumSha256 === "string" ? body.checksumSha256 : "",
    source: typeof body.source === "string" ? body.source : "upload"
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
      CREATE_GUARD
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

    const result = await createDocumentVersion(
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
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ version: result.version });
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
