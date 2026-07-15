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
  deactivateLegalEntity,
  fetchLegalEntityById,
  updateLegalEntity
} from "../../../../../modules/organization-structure/application/legal-entity-directory";

const IDEMPOTENCY_SCOPE = "organization_structure_legal_entity_delete";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "legal_entities",
  action: "read" as const
};

const UPDATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "legal_entities",
  action: "update" as const
};

const DELETE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "legal_entities",
  action: "delete" as const
};

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const legalEntityId = params.id;
  if (!legalEntityId) {
    return fail(400, "VALIDATION_ERROR", "Legal entity id is required.");
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

    const legalEntity = await fetchLegalEntityById(tx, tenantId, legalEntityId);
    if (!legalEntity) {
      return fail(404, "NOT_FOUND", "Legal entity not found.");
    }
    return ok({ legalEntity });
  });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const legalEntityId = params.id;
  if (!legalEntityId) {
    return fail(400, "VALIDATION_ERROR", "Legal entity id is required.");
  }

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    name: typeof body.name === "string" ? body.name : "",
    registrationIdentifier:
      typeof body.registrationIdentifier === "string"
        ? body.registrationIdentifier
        : null,
    registrationIdentifierLabel:
      typeof body.registrationIdentifierLabel === "string"
        ? body.registrationIdentifierLabel
        : null,
    effectiveFrom:
      typeof body.effectiveFrom === "string"
        ? new Date(body.effectiveFrom)
        : new Date(),
    effectiveTo:
      typeof body.effectiveTo === "string" ? new Date(body.effectiveTo) : null
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

    const result = await updateLegalEntity(
      tx,
      tenantId,
      auth.context.tenantUserId,
      legalEntityId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Legal entity not found.");
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    return ok({ legalEntity: result.legalEntity });
  });
};

/** `DELETE /api/v1/organization-structure/legal-entities/{id}` — deactivate (soft-delete). Reason is required (same convention `roles/[id].ts`'s `validateDeleteReasonRequestBody` establishes, spelled out inline here to avoid a new cross-module dependency on profile_identity). High-risk mutation: requires `Idempotency-Key` (same pattern `identity/business-scope/assignments/[id]/revoke.ts`/`data-lifecycle/legal-holds/[id]/release.ts` established for delete/revoke-class endpoints). */
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

  const legalEntityId = params.id;
  if (!legalEntityId) {
    return fail(400, "VALIDATION_ERROR", "Legal entity id is required.");
  }

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
    typeof body.deleteReason === "string" ? body.deleteReason : "";

  const requestHash = computeRequestHash({
    ...body,
    legalEntityId,
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

    const result = await deactivateLegalEntity(
      tx,
      tenantId,
      auth.context.tenantUserId,
      legalEntityId,
      { deleteReason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Legal entity not found.");
      }
      if (result.reason === "already_deactivated") {
        return fail(
          409,
          "ALREADY_DEACTIVATED",
          "Legal entity is already deactivated."
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

    const successResponse = ok({ legalEntity: result.legalEntity });
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
