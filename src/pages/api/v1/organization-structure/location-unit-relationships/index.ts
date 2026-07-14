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
  createLocationUnitRelationship,
  listLocationUnitRelationships
} from "../../../../../modules/organization-structure/application/location-unit-relationship-service";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "location_unit_relationships",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "location_unit_relationships",
  action: "create" as const
};

/** `GET /api/v1/organization-structure/location-unit-relationships?operationalLocationId=&organizationUnitId=&asOf=` (Issue #749). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const asOfParam = url.searchParams.get("asOf");
  let asOf: Date | undefined;
  if (asOfParam) {
    asOf = new Date(asOfParam);
    if (Number.isNaN(asOf.getTime())) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "asOf must be a valid ISO timestamp."
      );
    }
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

    const relationships = await listLocationUnitRelationships(tx, tenantId, {
      operationalLocationId:
        url.searchParams.get("operationalLocationId") ?? undefined,
      organizationUnitId:
        url.searchParams.get("organizationUnitId") ?? undefined,
      asOf
    });

    return ok({ relationships });
  });
};

/** `POST /api/v1/organization-structure/location-unit-relationships` (Issue #749). */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    operationalLocationId:
      typeof body.operationalLocationId === "string"
        ? body.operationalLocationId
        : "",
    organizationUnitId:
      typeof body.organizationUnitId === "string"
        ? body.organizationUnitId
        : "",
    relationshipType:
      body.relationshipType === "secondary"
        ? ("secondary" as const)
        : ("primary" as const),
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
      CREATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const result = await createLocationUnitRelationship(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "location_invalid") {
        return fail(
          422,
          "LOCATION_INVALID",
          "operationalLocationId does not reference an existing location for this tenant."
        );
      }
      if (result.reason === "unit_invalid") {
        return fail(
          422,
          "UNIT_INVALID",
          "organizationUnitId does not reference an existing organization unit for this tenant."
        );
      }
      if (result.reason === "already_related") {
        return fail(
          409,
          "ALREADY_RELATED",
          "This location and unit already have an open relationship."
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

    return ok({ relationship: result.relationship });
  });
};
