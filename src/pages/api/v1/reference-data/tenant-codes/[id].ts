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
  invalidJsonObjectBodyResponse,
  readJsonBody,
  readJsonObjectBody
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
import {
  mergeReferenceCodePatchInput,
  parseReferenceCodePatchInput
} from "../../../../../modules/reference-data/domain/code-patch";

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

/**
 * `PATCH /api/v1/reference-data/tenant-codes/{id}` — partial update of mutable
 * attributes. Requires `Idempotency-Key`.
 *
 * True `PATCH` semantics: an omitted field keeps its stored value; an explicit
 * `null` clears/resets it (`sortOrder` -> `0`, `metadata` -> `{}`, `validTo` ->
 * `null`). `validFrom` and `labels` reject `null` (both are always required).
 */
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

  const bodyRead = await readJsonObjectBody(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  if (!bodyRead.ok) return invalidJsonObjectBodyResponse(bodyRead.reason);
  const body = bodyRead.value;

  const parsed = parseReferenceCodePatchInput(body);
  if (!parsed.ok) {
    return fail(
      400,
      "VALIDATION_ERROR",
      parsed.errors
        .map((error) => `${error.field}: ${error.message}`)
        .join("; ")
    );
  }

  const requestHash = computeRequestHash({ ...body, id, action: "update" });
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

    const existing = await fetchTenantReferenceCodeById(tx, tenantId, id);
    if (!existing) return fail(404, "NOT_FOUND", "Tenant code not found.");

    // `{}` is a documented valid no-op (see the OpenAPI request-body note),
    // but `updateTenantReferenceCode` is unconditional: it would bump
    // `updated_at`, re-write the translation rows, emit an audit event and
    // append a `reference-code-updated` domain event for a request that
    // changes nothing. Answer with the current representation instead, so a
    // no-op stays observably a no-op. Deliberately AFTER authorization and the
    // 404/idempotency-replay checks — an empty patch must not become a way to
    // probe for a code's existence without holding the update permission.
    //
    // Every refusal `updateTenantReferenceCode` would have applied has to be
    // re-applied here, or the endpoint's answer starts depending on how many
    // fields the caller happened to send. Its UPDATE carries
    // `AND deprecated_at IS NULL` and reports `not_found` for a deprecated
    // row, so the empty patch must 404 on one too — otherwise a deprecated
    // tenant code reads back as a live, editable-looking 200 through this path
    // alone. (Issue #843 tracks removing this duplication outright.)
    if (Object.keys(parsed.patch).length === 0) {
      if (existing.deprecatedAt !== null) {
        return fail(404, "NOT_FOUND", "Tenant code not found.");
      }

      const noopResponse = ok({ tenantCode: existing });
      await saveIdempotencyRecord(
        tx,
        tenantId,
        UPDATE_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        requestHash,
        200,
        await noopResponse.clone().json()
      );
      return noopResponse;
    }

    const result = await updateTenantReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      mergeReferenceCodePatchInput(existing, parsed.patch),
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

  const requestHash = computeRequestHash({ ...body, id, action: "deprecate" });
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
