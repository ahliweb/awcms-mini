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
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { listModules } from "../../../../../../modules";
import { resolveServiceCatalogKeyRegistry } from "../../../../../../modules/service-catalog/domain/key-registry";
import { createDraftVersion } from "../../../../../../modules/service-catalog/application/plan-directory";

const IDEMPOTENCY_SCOPE = "service_catalog_version_create";

const UPDATE_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "plans",
  action: "update" as const
};

/**
 * `POST /api/v1/service-catalog/plans/{planKey}/versions` (Issue #870) — start
 * a new DRAFT version (N+1), seeded from the latest version's content, so a
 * published offer can be corrected without editing it in place. Requires
 * `Idempotency-Key` (the hash binds the resource: `planKey`).
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
  const requestHash = computeRequestHash({ planKey });
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
    const result = await createDraftVersion(
      tx,
      tenantId,
      auth.context.tenantUserId,
      planKey,
      registry,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Plan not found.");
      }
      if (result.reason === "draft_exists") {
        // D1: a concurrent SAME-key version-create may have won — replay its 200.
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
        return fail(
          409,
          "VALIDATION_ERROR",
          "This plan already has an open draft version — publish or discard it first."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }

    const successResponse = ok({
      plan: result.plan,
      version: result.version
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
