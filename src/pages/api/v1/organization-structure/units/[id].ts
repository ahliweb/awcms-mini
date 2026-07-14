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
  deactivateOrganizationUnit,
  fetchOrganizationUnitById,
  updateOrganizationUnit
} from "../../../../../modules/organization-structure/application/organization-unit-directory";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "units",
  action: "read" as const
};
const UPDATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "units",
  action: "update" as const
};
const DELETE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "units",
  action: "delete" as const
};

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const unitId = params.id;
  if (!unitId) return fail(400, "VALIDATION_ERROR", "Unit id is required.");

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

    const unit = await fetchOrganizationUnitById(tx, tenantId, unitId);
    if (!unit) return fail(404, "NOT_FOUND", "Organization unit not found.");
    return ok({ unit });
  });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const unitId = params.id;
  if (!unitId) return fail(400, "VALIDATION_ERROR", "Unit id is required.");

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    name: typeof body.name === "string" ? body.name : "",
    legalEntityId:
      typeof body.legalEntityId === "string" ? body.legalEntityId : null,
    unitTypeId: typeof body.unitTypeId === "string" ? body.unitTypeId : null,
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

    const result = await updateOrganizationUnit(
      tx,
      tenantId,
      auth.context.tenantUserId,
      unitId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Organization unit not found.");
      if (result.reason === "legal_entity_invalid") {
        return fail(
          422,
          "LEGAL_ENTITY_INVALID",
          "legalEntityId does not reference an existing legal entity for this tenant."
        );
      }
      if (result.reason === "unit_type_invalid") {
        return fail(
          422,
          "UNIT_TYPE_INVALID",
          "unitTypeId does not reference an existing organization-unit type for this tenant."
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

    return ok({ unit: result.unit });
  });
};

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

  const unitId = params.id;
  if (!unitId) return fail(400, "VALIDATION_ERROR", "Unit id is required.");

  const bodyRead = await readJsonBody<{ deleteReason?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const deleteReason =
    typeof body.deleteReason === "string" ? body.deleteReason : null;

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

    const result = await deactivateOrganizationUnit(
      tx,
      tenantId,
      auth.context.tenantUserId,
      unitId,
      deleteReason,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Organization unit not found.");
      return fail(
        409,
        "ALREADY_DEACTIVATED",
        "Organization unit is already deactivated."
      );
    }

    return ok({ unit: result.unit });
  });
};
