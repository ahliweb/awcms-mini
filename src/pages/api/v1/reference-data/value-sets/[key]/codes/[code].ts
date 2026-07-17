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
  invalidJsonObjectBodyResponse,
  readJsonBody,
  readJsonObjectBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { fetchReferenceValueSetByKey } from "../../../../../../../modules/reference-data/application/value-set-directory";
import {
  deprecateReferenceCode,
  fetchReferenceCodeByCode,
  updateReferenceCode
} from "../../../../../../../modules/reference-data/application/code-directory";
import type { ReferenceCodeRow } from "../../../../../../../modules/reference-data/application/code-directory";
import {
  mergeReferenceCodePatchInput,
  parseReferenceCodePatchInput
} from "../../../../../../../modules/reference-data/domain/code-patch";

const UPDATE_IDEMPOTENCY_SCOPE = "reference_data_code_update";
const DEPRECATE_IDEMPOTENCY_SCOPE = "reference_data_code_deprecate";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "read" as const
};
const UPDATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "update" as const
};
const DELETE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "delete" as const
};

async function resolveCode(
  tx: Bun.SQL,
  valueSetKey: string,
  codeString: string
): Promise<{ valueSetId: string; code: ReferenceCodeRow } | null> {
  const valueSet = await fetchReferenceValueSetByKey(tx, valueSetKey);
  if (!valueSet) return null;
  const code = await fetchReferenceCodeByCode(tx, valueSet.id, codeString);
  if (!code) return null;
  return { valueSetId: valueSet.id, code };
}

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  const codeParam = params.code;
  if (!key || !codeParam) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and code are required."
    );
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

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    const code = await fetchReferenceCodeByCode(tx, valueSet.id, codeParam);
    if (!code) return fail(404, "NOT_FOUND", "Code not found.");

    return ok({ code });
  });
};

/**
 * `PATCH /api/v1/reference-data/value-sets/{key}/codes/{code}` — partial update
 * of mutable fields. Requires `Idempotency-Key`.
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

  const key = params.key;
  const codeParam = params.code;
  if (!key || !codeParam) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and code are required."
    );
  }

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

  const requestHash = computeRequestHash({
    ...body,
    key,
    code: codeParam,
    action: "update"
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
      UPDATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const resolved = await resolveCode(tx, key, codeParam);
    if (!resolved) return fail(404, "NOT_FOUND", "Code not found.");

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

    // `{}` is a documented valid no-op (see the OpenAPI request-body note),
    // but `updateReferenceCode` is unconditional: it would bump `updated_at`,
    // re-write the translation rows, emit an audit event and append a
    // `reference-code-updated` domain event for a request that changes
    // nothing. Answer with the current representation instead, so a no-op
    // stays observably a no-op. Deliberately AFTER authorization and the
    // 404/idempotency-replay checks — an empty patch must not become a way to
    // probe for a code's existence without holding the update permission.
    //
    // The `managed_by_descriptor` refusal is re-checked here rather than
    // skipped: short-circuiting ahead of `updateReferenceCode` would otherwise
    // turn this module's "descriptor-managed rows are never manually edited"
    // invariant (issue #750) into a `200` for an empty patch, making the
    // endpoint's answer depend on how many fields the caller happened to send.
    if (Object.keys(parsed.patch).length === 0) {
      if (resolved.code.managedByDescriptor) {
        return fail(
          409,
          "DESCRIPTOR_MANAGED",
          "This code is managed by a module contribution and cannot be edited manually."
        );
      }

      const noopResponse = ok({ code: resolved.code });
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

    const result = await updateReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      resolved.code.id,
      mergeReferenceCodePatchInput(resolved.code, parsed.patch),
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Code not found.");
      if (result.reason === "descriptor_managed") {
        return fail(
          409,
          "DESCRIPTOR_MANAGED",
          "This code is managed by a module contribution and cannot be edited manually."
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

    const successResponse = ok({ code: result.code });
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

/** `DELETE /api/v1/reference-data/value-sets/{key}/codes/{code}` — deprecate (soft-delete), never a hard delete. Requires `Idempotency-Key` + a reason. */
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
  const codeParam = params.code;
  if (!key || !codeParam) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and code are required."
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{
    reason?: unknown;
    supersededByCodeId?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const reason = typeof body.reason === "string" ? body.reason : "";
  const supersededByCodeId =
    typeof body.supersededByCodeId === "string"
      ? body.supersededByCodeId
      : null;

  const requestHash = computeRequestHash({
    ...body,
    key,
    code: codeParam,
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

    const resolved = await resolveCode(tx, key, codeParam);
    if (!resolved) return fail(404, "NOT_FOUND", "Code not found.");

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

    const result = await deprecateReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      resolved.code.id,
      { reason, supersededByCodeId },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Code not found.");
      if (result.reason === "already_deprecated") {
        return fail(409, "ALREADY_DEPRECATED", "Code is already deprecated.");
      }
      if (result.reason === "descriptor_managed") {
        return fail(
          409,
          "DESCRIPTOR_MANAGED",
          "This code is managed by a module contribution and cannot be deprecated manually."
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

    const successResponse = ok({ code: result.code });
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
