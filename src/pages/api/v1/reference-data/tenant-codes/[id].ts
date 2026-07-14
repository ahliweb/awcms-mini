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
  deprecateTenantReferenceCode,
  fetchTenantReferenceCodeById,
  updateTenantReferenceCode
} from "../../../../../modules/reference-data/application/tenant-code-directory";
import type { ReferenceCodeLabelInput } from "../../../../../modules/reference-data/domain/code";

const UPDATE_IDEMPOTENCY_SCOPE = "reference_data_tenant_code_update";
const DEPRECATE_IDEMPOTENCY_SCOPE = "reference_data_tenant_code_deprecate";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "tenant_codes",
  action: "read" as const
};
const UPDATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "tenant_codes",
  action: "update" as const
};
const DELETE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "tenant_codes",
  action: "delete" as const
};

function parseLabels(value: unknown): ReferenceCodeLabelInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object"
    )
    .map((entry) => ({
      locale: typeof entry.locale === "string" ? entry.locale : "",
      label: typeof entry.label === "string" ? entry.label : "",
      description:
        typeof entry.description === "string" ? entry.description : null
    }));
}

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const id = params.id;
  if (!id) return fail(400, "VALIDATION_ERROR", "Tenant code id is required.");

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

    const tenantCode = await fetchTenantReferenceCodeById(tx, tenantId, id);
    if (!tenantCode) return fail(404, "NOT_FOUND", "Tenant code not found.");
    return ok({ tenantCode });
  });
};

/** `PATCH /api/v1/reference-data/tenant-codes/{id}` — update mutable attributes. Requires `Idempotency-Key`. */
export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const id = params.id;
  if (!id) return fail(400, "VALIDATION_ERROR", "Tenant code id is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    labels: parseLabels(body.labels),
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    metadata:
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : {},
    validFrom:
      typeof body.validFrom === "string"
        ? new Date(body.validFrom)
        : new Date(),
    validTo: typeof body.validTo === "string" ? new Date(body.validTo) : null
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
      UPDATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      UPDATE_IDEMPOTENCY_SCOPE,
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

    const result = await updateTenantReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Tenant code not found.");
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ tenantCode: result.tenantCode });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      UPDATE_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};

/** `DELETE /api/v1/reference-data/tenant-codes/{id}` — deprecate (soft-delete). Requires `Idempotency-Key` + a reason. */
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

  const id = params.id;
  if (!id) return fail(400, "VALIDATION_ERROR", "Tenant code id is required.");

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
      DEPRECATE_IDEMPOTENCY_SCOPE,
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

    const result = await deprecateTenantReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      { reason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Tenant code not found.");
      if (result.reason === "already_deprecated") {
        return fail(
          409,
          "ALREADY_DEPRECATED",
          "Tenant code is already deprecated."
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

    const successResponse = ok({ tenantCode: result.tenantCode });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      DEPRECATE_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};
