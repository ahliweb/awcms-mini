import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
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
  deactivateLegalEntity,
  fetchLegalEntityById,
  updateLegalEntity
} from "../../../../../modules/organization-structure/application/legal-entity-directory";

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

/** `DELETE /api/v1/organization-structure/legal-entities/{id}` — deactivate (soft-delete). Reason is required (same convention `roles/[id].ts`'s `validateDeleteReasonRequestBody` establishes, spelled out inline here to avoid a new cross-module dependency on profile_identity). */
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

  const bodyRead = await readJsonBody<{ deleteReason?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const deleteReason =
    typeof body.deleteReason === "string" ? body.deleteReason : "";

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

    return ok({ legalEntity: result.legalEntity });
  });
};
