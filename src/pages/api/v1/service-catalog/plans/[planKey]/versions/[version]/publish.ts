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
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../../../../../modules/_shared/idempotency";
import { listModules } from "../../../../../../../../modules";
import { resolveServiceCatalogKeyRegistry } from "../../../../../../../../modules/service-catalog/domain/key-registry";
import { publishVersion } from "../../../../../../../../modules/service-catalog/application/plan-directory";

const IDEMPOTENCY_SCOPE = "service_catalog_offer_publish";

const PUBLISH_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "offers",
  action: "publish" as const
};

/**
 * `POST /api/v1/service-catalog/plans/{planKey}/versions/{version}/publish`
 * (Issue #870) — validate + publish a draft version into an IMMUTABLE offer.
 * High-risk: requires `Idempotency-Key` (the hash binds the resource:
 * `planKey` + `version`), emits `awcms-mini.service-catalog.offer.published`,
 * and is audited.
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
      PUBLISH_GUARD
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

    const registry = resolveServiceCatalogKeyRegistry(listModules());
    const result = await publishVersion(
      tx,
      tenantId,
      auth.context.tenantUserId,
      planKey,
      version,
      registry,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Plan version not found.");
      }
      if (result.reason === "not_approved") {
        return fail(409, "OFFER_NOT_APPROVED", result.message);
      }
      if (result.reason === "not_draft") {
        // D1: a concurrent SAME-key publish may have won and already published
        // this version — replay its stored 200 rather than a misleading 409.
        const replay = await replayConcurrentIdempotentWinner(
          tx,
          tenantId,
          IDEMPOTENCY_SCOPE,
          idempotencyKey,
          requestHash
        );
        if (replay) {
          return jsonResponse(replay.responseBody, {
            status: replay.responseStatus
          });
        }
        return fail(409, "VALIDATION_ERROR", result.message);
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }

    const successResponse = ok({
      offer: {
        planKey: result.planKey,
        version: result.version,
        offerHash: result.offerHash
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
