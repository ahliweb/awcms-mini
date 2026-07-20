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
import { buildContractRegistry } from "../../../../modules/usage-metering/application/meter-registry";
import { parseReconcileBody } from "../../../../modules/usage-metering/application/request-parsing";
import {
  listReconciliationRuns,
  runReconciliation
} from "../../../../modules/usage-metering/application/reconciliation";
import {
  WINDOW_TYPES,
  type WindowType
} from "../../../../modules/usage-metering/domain/meter-semantics";

const IDEMPOTENCY_SCOPE = "usage_metering_reconciliation";

const READ_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "reconciliation",
  action: "read" as const
};
const RECONCILE_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "reconciliation",
  action: "reconcile" as const
};

/** `GET /api/v1/usage-metering/reconciliation` — list the current tenant's reconciliation runs. */
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

    const runs = await listReconciliationRuns(tx, tenantId);
    return ok({ runs });
  });
};

/**
 * `POST /api/v1/usage-metering/reconciliation` (Issue #875) — run a
 * reconciliation that recomputes each window in a bounded range from the
 * immutable events + corrections and flags any stored aggregate that drifts (or
 * is missing). Never repairs in place (repair = a worker rebuild); records
 * immutable evidence. High-risk: requires `Idempotency-Key`, emits
 * `usage.reconciled`, and is audited.
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
  const parsed = parseReconcileBody(body);

  if (!WINDOW_TYPES.includes(parsed.windowType as WindowType)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "windowType must be one of hour, day, month."
    );
  }
  if (Number.isNaN(Date.parse(parsed.rangeFrom))) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "rangeFrom must be an ISO 8601 timestamp."
    );
  }
  if (Number.isNaN(Date.parse(parsed.rangeTo))) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "rangeTo must be an ISO 8601 timestamp."
    );
  }
  if (parsed.meterKey !== null && typeof parsed.meterKey !== "string") {
    return fail(400, "VALIDATION_ERROR", "meterKey must be a string or null.");
  }

  const requestHash = computeRequestHash({
    meterKey: parsed.meterKey,
    windowType: parsed.windowType,
    rangeFrom: parsed.rangeFrom,
    rangeTo: parsed.rangeTo
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
      RECONCILE_GUARD
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
    const result = await runReconciliation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      registry,
      {
        meterKey: parsed.meterKey,
        windowType: parsed.windowType,
        rangeFrom: new Date(parsed.rangeFrom),
        rangeTo: new Date(parsed.rangeTo)
      },
      correlationId
    );

    if (!result.ok) {
      const conflictReplay = await replayConcurrentIdempotentWinner(
        tx,
        tenantId,
        IDEMPOTENCY_SCOPE,
        idempotencyKey,
        requestHash
      );
      if (conflictReplay) {
        return jsonResponse(conflictReplay.responseBody, {
          status: conflictReplay.responseStatus
        });
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }

    const successResponse = ok({ run: result.run });
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
