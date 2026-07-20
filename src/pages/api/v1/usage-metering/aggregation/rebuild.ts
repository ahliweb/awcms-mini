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
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { requestAggregateRebuild } from "../../../../../modules/usage-metering/application/rebuild-directory";

const IDEMPOTENCY_SCOPE = "usage_metering_rebuild";
const SHARD_KEY = "default";

const REBUILD_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "aggregation",
  action: "rebuild" as const
};

/**
 * `POST /api/v1/usage-metering/aggregation/rebuild` (Issue #875) — request a
 * full deterministic recompute of the current tenant's usage aggregate windows
 * from the immutable events (a rebuild reproduces the stored aggregates). Flags
 * the aggregation cursor; the worker consumes the flag on its next run. The
 * request itself never mutates the checkpoint or any usage record. High-risk:
 * requires `Idempotency-Key`, audited.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }
  // Resource-id-bound hash (memory idempotency-hash-missing-resource-id): the
  // aggregation-cursor shard is the resource this rebuild targets.
  const requestHash = computeRequestHash({ shardKey: SHARD_KEY });

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      REBUILD_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const result = await requestAggregateRebuild(
      tx,
      tenantId,
      auth.context.tenantUserId,
      correlationId
    );

    const successResponse = ok({ rebuild: result });
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
