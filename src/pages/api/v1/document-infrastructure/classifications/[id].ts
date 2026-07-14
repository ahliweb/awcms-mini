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
  deactivateClassification,
  fetchClassificationById,
  updateClassification
} from "../../../../../modules/document-infrastructure/application/document-classification-directory";

const IDEMPOTENCY_SCOPE = "document_infrastructure_classification_delete";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "classifications",
  action: "read" as const
};

const UPDATE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "classifications",
  action: "update" as const
};

const DELETE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "classifications",
  action: "delete" as const
};

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const classificationId = params.id;
  if (!classificationId) {
    return fail(400, "VALIDATION_ERROR", "Classification id is required.");
  }

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

    const classification = await fetchClassificationById(
      tx,
      tenantId,
      classificationId
    );
    if (!classification) {
      return fail(404, "NOT_FOUND", "Classification not found.");
    }
    return ok({ classification });
  });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const classificationId = params.id;
  if (!classificationId) {
    return fail(400, "VALIDATION_ERROR", "Classification id is required.");
  }

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : null,
    confidentialityLevel:
      typeof body.confidentialityLevel === "string"
        ? body.confidentialityLevel
        : "internal",
    retentionReference:
      typeof body.retentionReference === "string"
        ? body.retentionReference
        : null
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

    const result = await updateClassification(
      tx,
      tenantId,
      auth.context.tenantUserId,
      classificationId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Classification not found.");
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    return ok({ classification: result.classification });
  });
};

/** `DELETE /api/v1/document-infrastructure/classifications/{id}` — deactivate (soft-delete). High-risk mutation: requires `Idempotency-Key`. */
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

  const classificationId = params.id;
  if (!classificationId) {
    return fail(400, "VALIDATION_ERROR", "Classification id is required.");
  }

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

    const result = await deactivateClassification(
      tx,
      tenantId,
      auth.context.tenantUserId,
      classificationId,
      { deleteReason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Classification not found.");
      }
      if (result.reason === "already_deactivated") {
        return fail(
          409,
          "ALREADY_DEACTIVATED",
          "Classification is already deactivated."
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

    const successResponse = ok({ classification: result.classification });
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
