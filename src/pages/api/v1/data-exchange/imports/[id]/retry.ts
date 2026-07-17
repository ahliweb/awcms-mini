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
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import {
  getImportBatchById,
  requestImportRetry,
  resolveImportDescriptor
} from "../../../../../../modules/data-exchange/application/import-batch-directory";
import { authorizeExchangeDescriptorPermission } from "../../../../../../modules/data-exchange/application/descriptor-authorization";

const IDEMPOTENCY_SCOPE = "data_exchange_import_retry";

const RETRY_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "imports",
  action: "retry" as const
};

/**
 * `POST /api/v1/data-exchange/imports/{id}/retry` (Issue #752) — resumes a
 * `partially_committed`/`failed` batch's commit from its saved cursor.
 * Requires `Idempotency-Key`.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const batchId = params.id;
  if (!batchId)
    return fail(400, "VALIDATION_ERROR", "id path parameter is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const requestHash = computeRequestHash({ batchId });
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
      RETRY_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const existingBatch = await getImportBatchById(tx, tenantId, batchId);
    // A missing batch answers 404 further below (via `requestImportRetry`).
    // An EXISTING batch whose importKey no longer resolves, however, is the
    // module-disabled-after-staging case (Issue #820 Cacat 3): retrying
    // re-runs the owning module's adapter, so it must fail CLOSED here
    // rather than skip the descriptor gate the way passing `null` used to.
    if (existingBatch) {
      const retryDescriptor = resolveImportDescriptor(existingBatch.importKey);
      if (!retryDescriptor) {
        return fail(
          409,
          "INVALID_STATE",
          `Import batch cannot be retried: importKey "${existingBatch.importKey}" is no longer registered — its owning module may be disabled.`
        );
      }
      const descriptorPermCheck = await authorizeExchangeDescriptorPermission(
        tx,
        tenantId,
        tokenHash,
        now,
        retryDescriptor
      );
      if (!descriptorPermCheck.allowed) return descriptorPermCheck.denied;
    }

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

    const result = await requestImportRetry(
      tx,
      tenantId,
      auth.context.tenantUserId,
      batchId,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Import batch not found.");
      }
      return fail(
        409,
        "INVALID_STATE",
        `Import batch cannot be retried from status "${result.status}".`
      );
    }

    const successResponse = ok({ batch: result.batch });
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
