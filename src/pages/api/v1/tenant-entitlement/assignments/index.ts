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
  assignEntitlement,
  listAssignments
} from "../../../../../modules/tenant-entitlement/application/entitlement-directory";
import { parseAssignBody } from "../../../../../modules/tenant-entitlement/application/request-parsing";

const IDEMPOTENCY_SCOPE = "tenant_entitlement_assign";

const READ_GUARD = {
  moduleKey: "tenant_entitlement",
  activityCode: "assignments",
  action: "read" as const
};
const ASSIGN_GUARD = {
  moduleKey: "tenant_entitlement",
  activityCode: "assignments",
  action: "assign" as const
};

/** `GET /api/v1/tenant-entitlement/assignments` — list the current tenant's entitlement assignments. */
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

    const assignments = await listAssignments(tx, tenantId);
    return ok({ assignments });
  });
};

/**
 * `POST /api/v1/tenant-entitlement/assignments` (Issue #871) — assign
 * (subscribe) the current tenant to a published offer version; supersedes the
 * current assignment for that plan. High-risk: requires `Idempotency-Key`
 * (hash binds planKey + offerVersion), emits
 * `awcms-mini.tenant-entitlement.assignment.changed`, and is audited.
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
  const input = parseAssignBody(body);
  const requestHash = computeRequestHash({
    planKey: input.planKey,
    offerVersion: input.offerVersion,
    source: input.source,
    reason: input.reason,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    trialEndsAt: input.trialEndsAt,
    graceEndsAt: input.graceEndsAt
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
      ASSIGN_GUARD
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
    const result = await assignEntitlement(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
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
      if (result.reason === "offer_not_found") {
        return fail(
          404,
          "RESOURCE_NOT_FOUND",
          "No published offer for that planKey + offerVersion."
        );
      }
      // conflict: a concurrent assign for the same plan won. Replay a
      // same-Idempotency-Key winner if present, else a deterministic 409.
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
        "A concurrent assignment for this plan superseded this request."
      );
    }

    const successResponse = ok({ assignment: result.assignment });
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
