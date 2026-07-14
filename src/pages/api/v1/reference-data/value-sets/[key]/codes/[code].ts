import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { fetchReferenceValueSetByKey } from "../../../../../../../modules/reference-data/application/value-set-directory";
import {
  deprecateReferenceCode,
  fetchReferenceCodeByCode,
  updateReferenceCode
} from "../../../../../../../modules/reference-data/application/code-directory";
import type { ReferenceCodeLabelInput } from "../../../../../../../modules/reference-data/domain/code";

const UPDATE_IDEMPOTENCY_SCOPE = "reference_data_code_update";
const DEPRECATE_IDEMPOTENCY_SCOPE = "reference_data_code_deprecate";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "read" as const
};
const UPDATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "update" as const
};
const DELETE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "delete" as const
};

function parseLabels(value: unknown): ReferenceCodeLabelInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object"
    )
    .map((entry) => ({
      locale: typeof entry.locale === "string" ? entry.locale : "",
      label: typeof entry.label === "string" ? entry.label : "",
      description:
        typeof entry.description === "string" ? entry.description : null
    }));
}

async function resolveCodeId(
  tx: Bun.SQL,
  valueSetKey: string,
  codeString: string
): Promise<{ valueSetId: string; codeId: string } | null> {
  const valueSet = await fetchReferenceValueSetByKey(tx, valueSetKey);
  if (!valueSet) return null;
  const code = await fetchReferenceCodeByCode(tx, valueSet.id, codeString);
  if (!code) return null;
  return { valueSetId: valueSet.id, codeId: code.id };
}

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  const codeParam = params.code;
  if (!key || !codeParam) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and code are required."
    );
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

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    const code = await fetchReferenceCodeByCode(tx, valueSet.id, codeParam);
    if (!code) return fail(404, "NOT_FOUND", "Code not found.");

    return ok({ code });
  });
};

/** `PATCH /api/v1/reference-data/value-sets/{key}/codes/{code}` — mutable-fields-only update. Requires `Idempotency-Key`. */
export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  const codeParam = params.code;
  if (!key || !codeParam) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and code are required."
    );
  }

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
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    labels: parseLabels(body.labels),
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    metadata:
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : {},
    validFrom:
      typeof body.validFrom === "string"
        ? new Date(body.validFrom)
        : new Date(),
    validTo: typeof body.validTo === "string" ? new Date(body.validTo) : null
  };

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
      UPDATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const resolved = await resolveCodeId(tx, key, codeParam);
    if (!resolved) return fail(404, "NOT_FOUND", "Code not found.");

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      UPDATE_IDEMPOTENCY_SCOPE,
      idempotencyKey
    );
    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    const result = await updateReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      resolved.codeId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Code not found.");
      if (result.reason === "descriptor_managed") {
        return fail(
          409,
          "DESCRIPTOR_MANAGED",
          "This code is managed by a module contribution and cannot be edited manually."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ code: result.code });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      UPDATE_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};

/** `DELETE /api/v1/reference-data/value-sets/{key}/codes/{code}` — deprecate (soft-delete), never a hard delete. Requires `Idempotency-Key` + a reason. */
export const DELETE: APIRoute = async ({
  request,
  cookies,
  params,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  const codeParam = params.code;
  if (!key || !codeParam) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and code are required."
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{
    reason?: unknown;
    supersededByCodeId?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const reason = typeof body.reason === "string" ? body.reason : "";
  const supersededByCodeId =
    typeof body.supersededByCodeId === "string"
      ? body.supersededByCodeId
      : null;

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
      DELETE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const resolved = await resolveCodeId(tx, key, codeParam);
    if (!resolved) return fail(404, "NOT_FOUND", "Code not found.");

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      DEPRECATE_IDEMPOTENCY_SCOPE,
      idempotencyKey
    );
    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    const result = await deprecateReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      resolved.codeId,
      { reason, supersededByCodeId },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Code not found.");
      if (result.reason === "already_deprecated") {
        return fail(409, "ALREADY_DEPRECATED", "Code is already deprecated.");
      }
      if (result.reason === "descriptor_managed") {
        return fail(
          409,
          "DESCRIPTOR_MANAGED",
          "This code is managed by a module contribution and cannot be deprecated manually."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ code: result.code });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      DEPRECATE_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};
