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
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { listModules } from "../../../../../modules";
import { createServiceCatalogReadPort } from "../../../../../modules/service-catalog/application/service-catalog-read-port-adapter";
import {
  createOverride,
  listOverrides
} from "../../../../../modules/tenant-entitlement/application/entitlement-directory";
import { resolveEntitlementKeyRegistry } from "../../../../../modules/tenant-entitlement/domain/entitlement-key-registry";
import { parseOverrideBody } from "../../../../../modules/tenant-entitlement/application/request-parsing";

const IDEMPOTENCY_SCOPE = "tenant_entitlement_override";

const READ_GUARD = {
  moduleKey: "tenant_entitlement",
  activityCode: "overrides",
  action: "read" as const
};
const OVERRIDE_GUARD = {
  moduleKey: "tenant_entitlement",
  activityCode: "overrides",
  action: "override" as const
};

/** `GET /api/v1/tenant-entitlement/overrides` — list the current tenant's overrides. */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      READ_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const overrides = await listOverrides(tx, tenantId);
    return ok({ overrides });
  });
};

/**
 * `POST /api/v1/tenant-entitlement/overrides` (Issue #871) — create a
 * platform-operator override (grant/deny a feature, module, or quota;
 * reason-bound, optionally time-bound). Unknown target keys FAIL CLOSED (400).
 * High-risk: requires `Idempotency-Key`, emits `override.changed`, and is
 * audited.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseOverrideBody(body);
  const requestHash = computeRequestHash({
    targetKind: input.targetKind,
    targetKey: input.targetKey,
    effect: input.effect,
    quotaIsUnlimited: input.quotaIsUnlimited,
    quotaLimitValue: input.quotaLimitValue,
    quotaUnit: input.quotaUnit,
    reason: input.reason,
    source: input.source,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo
  });

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      OVERRIDE_GUARD
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
    const registry = resolveEntitlementKeyRegistry(listModules());
    const result = await createOverride(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      registry,
      deps,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "validation") {
        return fail(
          400,
          "VALIDATION_ERROR",
          result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
        );
      }
      // override_exists: an active override for this key already exists.
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
        "An active override already exists for this target — revoke it first."
      );
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
