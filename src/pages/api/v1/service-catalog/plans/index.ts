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
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { listModules } from "../../../../../modules";
import { resolveServiceCatalogKeyRegistry } from "../../../../../modules/service-catalog/domain/key-registry";
import {
  createPlan,
  listPlans
} from "../../../../../modules/service-catalog/application/plan-directory";
import { parseCreatePlanBody } from "../../../../../modules/service-catalog/application/request-parsing";
import type {
  PlanStatus,
  PlanType
} from "../../../../../modules/service-catalog/domain/plan";

const IDEMPOTENCY_SCOPE = "service_catalog_plan_create";

const READ_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "plans",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "plans",
  action: "create" as const
};

/** `GET /api/v1/service-catalog/plans?status=&planType=` (Issue #870). Operator list of the GLOBAL catalog. */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  if (statusParam && statusParam !== "active" && statusParam !== "archived") {
    return fail(400, "VALIDATION_ERROR", "status must be active or archived.");
  }
  const planTypeParam = url.searchParams.get("planType");
  if (
    planTypeParam &&
    !["subscription", "addon", "bundle", "custom"].includes(planTypeParam)
  ) {
    return fail(400, "VALIDATION_ERROR", "planType is invalid.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      READ_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const plans = await listPlans(tx, {
      status: (statusParam as PlanStatus) ?? undefined,
      planType: (planTypeParam as PlanType) ?? undefined
    });

    return ok({ plans });
  });
};

/**
 * `POST /api/v1/service-catalog/plans` (Issue #870) — create a draft plan and
 * its first draft version. Writes to the GLOBAL control-plane catalog;
 * `service_catalog.plans.create` is platform-operator only. Requires
 * `Idempotency-Key`.
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

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "large"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = parseCreatePlanBody(body);
  const requestHash = computeRequestHash(body);
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
      CREATE_GUARD
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
    const result = await createPlan(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      registry,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "duplicate_key") {
        // D1: a concurrent SAME-key create may have won — replay its 200.
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
          "A plan with this planKey already exists."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }

    const successResponse = ok({ plan: result.plan });
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
