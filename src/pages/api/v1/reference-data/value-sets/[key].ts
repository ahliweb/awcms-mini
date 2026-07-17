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
  deprecateReferenceValueSet,
  fetchReferenceValueSetByKey,
  updateReferenceValueSet
} from "../../../../../modules/reference-data/application/value-set-directory";
import {
  mergeReferenceValueSetPatch,
  parseReferenceValueSetPatch
} from "../../../../../modules/reference-data/domain/value-set-patch";

const DEPRECATE_IDEMPOTENCY_SCOPE = "reference_data_value_set_deprecate";
const UPDATE_IDEMPOTENCY_SCOPE = "reference_data_value_set_update";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "value_sets",
  action: "read" as const
};
const UPDATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "value_sets",
  action: "update" as const
};
const DELETE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "value_sets",
  action: "delete" as const
};

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

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

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");
    return ok({ valueSet });
  });
};

/** `PATCH /api/v1/reference-data/value-sets/{key}` — metadata-only update (name/description). Requires `Idempotency-Key`. */
export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{
    name?: unknown;
    description?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  // True partial-PATCH semantics (Issue #837): an omitted field keeps its
  // stored value, an explicit `null` clears `description`, and `name` rejects
  // `null` (`NOT NULL`). The pre-#837 route defaulted an omitted `description`
  // to `null`, so a PATCH that changed only `name` silently cleared it.
  const parsed = parseReferenceValueSetPatch(body);
  if (!parsed.ok) {
    return fail(
      400,
      "VALIDATION_ERROR",
      parsed.errors
        .map((error) => `${error.field}: ${error.message}`)
        .join("; ")
    );
  }

  const requestHash = computeRequestHash({ ...body, key, action: "update" });
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

    const existing = await fetchReferenceValueSetByKey(tx, key);
    if (!existing) return fail(404, "NOT_FOUND", "Value set not found.");

    const result = await updateReferenceValueSet(
      tx,
      tenantId,
      auth.context.tenantUserId,
      key,
      mergeReferenceValueSetPatch(existing, parsed.patch),
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Value set not found.");
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ valueSet: result.valueSet });
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

/** `DELETE /api/v1/reference-data/value-sets/{key}` — deprecate (soft-delete), never a hard delete. Requires `Idempotency-Key` + a reason. */
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

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

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
    key,
    action: "deprecate"
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

    const result = await deprecateReferenceValueSet(
      tx,
      tenantId,
      auth.context.tenantUserId,
      key,
      { reason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Value set not found.");
      if (result.reason === "already_deprecated") {
        return fail(
          409,
          "ALREADY_DEPRECATED",
          "Value set is already deprecated."
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

    const successResponse = ok({ valueSet: result.valueSet });
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
