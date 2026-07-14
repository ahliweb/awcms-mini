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
  createReferenceCode,
  listReferenceCodes
} from "../../../../../../../modules/reference-data/application/code-directory";
import type { ReferenceCodeLabelInput } from "../../../../../../../modules/reference-data/domain/code";

const IDEMPOTENCY_SCOPE = "reference_data_code_create";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "codes",
  action: "create" as const
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

/** `GET /api/v1/reference-data/value-sets/{key}/codes?includeDeprecated=&search=` (Issue #750). */
export const GET: APIRoute = async ({ request, cookies, params, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

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

    const codes = await listReferenceCodes(tx, valueSet.id, {
      includeDeprecated: url.searchParams.get("includeDeprecated") === "true",
      search: url.searchParams.get("search") ?? undefined
    });

    return ok({ codes });
  });
};

/** `POST /api/v1/reference-data/value-sets/{key}/codes` — creates a manually-added code (never a descriptor-managed one). Requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

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
    code: typeof body.code === "string" ? body.code : "",
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
      CREATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
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

    const result = await createReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      valueSet.id,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "duplicate_code") {
        return fail(
          409,
          "DUPLICATE_CODE",
          "A code with this value already exists in this value set."
        );
      }
      if (result.reason === "value_set_not_found") {
        return fail(404, "NOT_FOUND", "Value set not found.");
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
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};
