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
import { requestImportCommit } from "../../../../../../modules/data-exchange/application/import-batch-directory";

const IDEMPOTENCY_SCOPE = "data_exchange_import_commit";

const COMMIT_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "imports",
  action: "post" as const
};

/**
 * `POST /api/v1/data-exchange/imports/{id}/commit` (Issue #752) — triggers
 * the asynchronous idempotent commit of a previewed import batch. Never
 * blocks on the actual row-by-row work (that runs on
 * `bun run data-exchange:worker`) — returns immediately once the batch's
 * status flips to `committing`. High-risk mutation: requires
 * `Idempotency-Key`.
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
      COMMIT_GUARD
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

    const result = await requestImportCommit(
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
        `Import batch must be in "previewed" status to commit (currently "${result.status}").`
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
