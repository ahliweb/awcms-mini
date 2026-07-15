import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../../modules/_shared/idempotency";
import { fetchReferenceValueSetByKey } from "../../../../../../../../modules/reference-data/application/value-set-directory";
import {
  fetchReferenceCodeByCode,
  restoreReferenceCode
} from "../../../../../../../../modules/reference-data/application/code-directory";

const IDEMPOTENCY_SCOPE = "reference_data_code_restore";

const RESTORE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "restore" as const
};

/** `POST /api/v1/reference-data/value-sets/{key}/codes/{code}/restore` (Issue #750). Requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
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

  const requestHash = computeRequestHash({
    key,
    code: codeParam,
    action: "restore"
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
      RESTORE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");
    const code = await fetchReferenceCodeByCode(tx, valueSet.id, codeParam);
    if (!code) return fail(404, "NOT_FOUND", "Code not found.");

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

    const result = await restoreReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      code.id,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Code not found.");
      if (result.reason === "descriptor_managed") {
        return fail(
          409,
          "DESCRIPTOR_MANAGED",
          "This code is managed by a module contribution and cannot be restored manually."
        );
      }
      return fail(409, "NOT_DEPRECATED", "Code is not currently deprecated.");
    }

    const successResponse = ok({ code: result.code });
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
