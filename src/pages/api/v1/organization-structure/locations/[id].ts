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
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import {
  deleteOperationalLocation,
  fetchOperationalLocationById,
  updateOperationalLocation
} from "../../../../../modules/organization-structure/application/operational-location-directory";

const IDEMPOTENCY_SCOPE = "organization_structure_location_delete";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "locations",
  action: "read" as const
};
const UPDATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "locations",
  action: "update" as const
};
const DELETE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "locations",
  action: "delete" as const
};

function parseNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return null;
}

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const locationId = params.id;
  if (!locationId)
    return fail(400, "VALIDATION_ERROR", "Location id is required.");

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

    const location = await fetchOperationalLocationById(
      tx,
      tenantId,
      locationId
    );
    if (!location)
      return fail(404, "NOT_FOUND", "Operational location not found.");
    return ok({ location });
  });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const locationId = params.id;
  if (!locationId)
    return fail(400, "VALIDATION_ERROR", "Location id is required.");

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    name: typeof body.name === "string" ? body.name : "",
    addressLine1:
      typeof body.addressLine1 === "string" ? body.addressLine1 : null,
    addressLine2:
      typeof body.addressLine2 === "string" ? body.addressLine2 : null,
    city: typeof body.city === "string" ? body.city : null,
    region: typeof body.region === "string" ? body.region : null,
    postalCode: typeof body.postalCode === "string" ? body.postalCode : null,
    countryCode: typeof body.countryCode === "string" ? body.countryCode : null,
    latitude: parseNumberOrNull(body.latitude),
    longitude: parseNumberOrNull(body.longitude)
  };

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

    const result = await updateOperationalLocation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locationId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Operational location not found.");
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    return ok({ location: result.location });
  });
};

/** High-risk mutation: requires `Idempotency-Key`. */
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

  const locationId = params.id;
  if (!locationId)
    return fail(400, "VALIDATION_ERROR", "Location id is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{ deleteReason?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const deleteReason =
    typeof body.deleteReason === "string" ? body.deleteReason : null;

  const requestHash = computeRequestHash({
    ...body,
    locationId,
    action: "delete"
  });
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

    const result = await deleteOperationalLocation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locationId,
      deleteReason,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Operational location not found.");
      return fail(
        409,
        "ALREADY_DELETED",
        "Operational location is already soft-deleted."
      );
    }

    const successResponse = ok({ location: result.location });
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
