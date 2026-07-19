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
import { retireVersion } from "../../../../../../../../modules/service-catalog/application/plan-directory";

const IDEMPOTENCY_SCOPE = "service_catalog_offer_retire";

const RETIRE_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "offers",
  action: "retire" as const
};

/**
 * `POST /api/v1/service-catalog/plans/{planKey}/versions/{version}/retire`
 * (Issue #870) — retire a published offer version. The offer stays readable.
 * High-risk (`retire` is in HIGH_RISK_ACTIONS): requires `Idempotency-Key`
 * (hash binds `planKey` + `version`), emits
 * `awcms-mini.service-catalog.offer.retired`, and is audited.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
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

  const planKey = params.planKey ?? "";
  const version = Number(params.version);
  if (!Number.isInteger(version) || version < 1) {
    return fail(400, "VALIDATION_ERROR", "version must be a positive integer.");
  }

  const requestHash = computeRequestHash({ planKey, version });
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
      RETIRE_GUARD
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

    const result = await retireVersion(
      tx,
      tenantId,
      auth.context.tenantUserId,
      planKey,
      version,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Plan version not found.");
      }
      return fail(409, "VALIDATION_ERROR", result.message);
    }

    const successResponse = ok({
      offer: {
        planKey: result.planKey,
        version: result.version
      }
    });
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
