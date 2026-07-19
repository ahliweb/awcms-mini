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
import { createServiceCatalogReadPort } from "../../../../../../modules/service-catalog/application/service-catalog-read-port-adapter";
import { revokeOverride } from "../../../../../../modules/tenant-entitlement/application/entitlement-directory";

const IDEMPOTENCY_SCOPE = "tenant_entitlement_override_revoke";

const REVOKE_GUARD = {
  moduleKey: "tenant_entitlement",
  activityCode: "overrides",
  action: "revoke" as const
};

/**
 * `POST /api/v1/tenant-entitlement/overrides/{overrideId}/revoke` (Issue #871)
 * — revoke an override (one-way; stops applying immediately without restart).
 * High-risk: requires `Idempotency-Key`, emits `override.changed`, and is
 * audited.
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

  const overrideId = params.overrideId ?? "";

  let reason: string | null = null;
  try {
    const body = await request.json();
    if (body && typeof body === "object" && "reason" in body) {
      const raw = (body as Record<string, unknown>).reason;
      reason = typeof raw === "string" ? raw : null;
    }
  } catch {
    // An empty/absent body is fine for a revoke — reason is optional here.
    reason = null;
  }

  const requestHash = computeRequestHash({ overrideId, reason });

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      REVOKE_GUARD
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

    const deps = {
      catalogPort: createServiceCatalogReadPort(tx),
      moduleDescriptors: listModules()
    };
    const result = await revokeOverride(
      tx,
      tenantId,
      auth.context.tenantUserId,
      overrideId,
      reason,
      deps,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Override not found.");
      }
      // already_revoked: replay a same-Idempotency-Key winner if present.
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
      return fail(409, "VALIDATION_ERROR", "This override is already revoked.");
    }

    const successResponse = ok({ override: result.override });
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
