import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../modules/_shared/idempotency";
import { listModules } from "../../../../modules";
import {
  applyCorrection,
  listCorrections
} from "../../../../modules/usage-metering/application/correction-directory";
import { buildContractRegistry } from "../../../../modules/usage-metering/application/meter-registry";
import { parseCorrectionBody } from "../../../../modules/usage-metering/application/request-parsing";

const IDEMPOTENCY_SCOPE = "usage_metering_correction";

const READ_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "corrections",
  action: "read" as const
};
const CORRECT_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "corrections",
  action: "correct" as const
};

/** `GET /api/v1/usage-metering/corrections` — list the current tenant's corrections, optionally `?meterKey=`. */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const meterKey = new URL(request.url).searchParams.get("meterKey");

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

    const corrections = await listCorrections(tx, tenantId, meterKey);
    return ok({ corrections });
  });
};

/**
 * `POST /api/v1/usage-metering/corrections` (Issue #875) — apply a signed
 * correction/reversal LINKED to an original immutable event (never mutates the
 * source event). Only a `signed_delta` sum meter can be corrected (fail-closed).
 * High-risk: requires `Idempotency-Key`, emits `usage.corrected`, and is audited
 * (WITHOUT the free-text reason in the event payload).
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
  const input = parseCorrectionBody(body);
  // Resource-id-bound hash (memory idempotency-hash-missing-resource-id): the
  // original event id is the resource this correction targets.
  const requestHash = computeRequestHash({
    originalEventId: input.originalEventId,
    correctionType: input.correctionType,
    deltaQuantity: input.deltaQuantity,
    reason: input.reason,
    producer: input.producer,
    sourceEventId: input.sourceEventId,
    sourceVersion: input.sourceVersion
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
      CORRECT_GUARD
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

    const registry = buildContractRegistry(listModules());
    const result = await applyCorrection(
      tx,
      tenantId,
      auth.context.tenantUserId,
      registry,
      input,
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
      if (result.reason === "unknown_meter") {
        return fail(
          400,
          "VALIDATION_ERROR",
          "The original event's meter is not a known #874 meter (fail-closed)."
        );
      }
      if (result.reason === "event_not_found") {
        return fail(
          404,
          "NOT_FOUND",
          "No usage event with that id exists for this tenant."
        );
      }
      // conflict: a correction with this idempotency identity already exists.
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
        "A correction with this producer identity already exists."
      );
    }

    const successResponse = ok({ correction: result.correction });
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
