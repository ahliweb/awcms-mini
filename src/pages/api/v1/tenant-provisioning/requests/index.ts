import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import {
  assertUuid,
  withTenant
} from "../../../../../lib/database/tenant-context";
import {
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { parseProvisioningRequestBody } from "../../../../../modules/tenant-provisioning/application/request-parsing";
import {
  computeProvisioningInputsHash,
  requestProvisioning
} from "../../../../../modules/tenant-provisioning/application/provisioning-orchestrator";
import { authorizeOperator, buildEngineDeps } from "../_support";

const IDEMPOTENCY_SCOPE = "tenant_provisioning_request";

/**
 * `POST /api/v1/tenant-provisioning/requests` (Issue #872) — request an
 * idempotent tenant provisioning run. Creates the target tenant record (ACID
 * anti-duplicate on `tenant_code`), owner, office, settings, and the run +
 * steps (bootstrap + owner pre-completed) in ONE transaction, then returns the
 * run. Platform-operator only + default-deny; requires `Idempotency-Key`.
 *
 * The Idempotency-Key is bound to the FULL request hash in the PLATFORM
 * operator tenant's generic idempotency store (doc 10, review L-2): a same
 * key + same payload REPLAYS the stored response; a same key + DIFFERENT
 * payload is a clean 409 (never a silent second tenant). The tenant is created
 * INACTIVE — `start` runs the remaining steps and readiness activates it.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const correlationId = locals.correlationId;

  const auth = await authorizeOperator(
    request,
    cookies,
    "requests",
    "create",
    correlationId
  );
  if (auth instanceof Response) return auth;

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
  const input = parseProvisioningRequestBody(body);
  const requestHash = computeProvisioningInputsHash(input);

  const sql = getDatabaseClient();
  const deps = buildEngineDeps(correlationId);
  const platformTenantId = auth.operatorTenantId;

  return withTenant(sql, platformTenantId, async (tx) => {
    // Idempotency binding in the PLATFORM tenant: same key + different payload
    // -> 409 (never a second tenant); same key + same payload -> replay.
    const existing = await findIdempotencyRecord(
      tx,
      platformTenantId,
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

    // `requestProvisioning` creates the target tenant (RLS-free) and switches
    // the tx context to it; switch BACK to the platform tenant to persist the
    // idempotency record under the operator's scope.
    const result = await requestProvisioning(
      tx,
      {
        actorTenantUserId: auth.actorTenantUserId,
        idempotencyKey,
        correlationId
      },
      input,
      deps.onboarding
    );
    await tx.unsafe(
      `SET LOCAL app.current_tenant_id = '${assertUuid(platformTenantId)}'`
    );

    if (!result.ok) {
      // Don't persist an idempotency record for a validation/conflict failure
      // (the operator may retry with corrected input under the same key).
      if (result.reason === "validation") {
        return fail(
          400,
          "VALIDATION_ERROR",
          result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
        );
      }
      return fail(409, "PROVISIONING_CONFLICT", result.message);
    }

    const status = result.replayed ? 200 : 201;
    const responseBody = await ok({ request: result.request }).clone().json();
    // A concurrent same-key winner triggers IdempotencyRaceLostError here, which
    // `withTenant` catches (rolling back any partial second-tenant creation) and
    // either replays the winner (same hash) or returns a clean 409 (diff hash).
    await saveIdempotencyRecord(
      tx,
      platformTenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      status,
      responseBody
    );
    return jsonResponse(responseBody, { status });
  });
};
