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
  createOrganizationUnit,
  listOrganizationUnits
} from "../../../../../modules/organization-structure/application/organization-unit-directory";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "units",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "units",
  action: "create" as const
};

/** `GET /api/v1/organization-structure/units?search=&legalEntityId=&status=&cursor=` (Issue #749) — keyset-paginated list/search. */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  if (statusParam && statusParam !== "active" && statusParam !== "inactive") {
    return fail(400, "VALIDATION_ERROR", "status must be active or inactive.");
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

    try {
      const result = await listOrganizationUnits(tx, tenantId, {
        search: url.searchParams.get("search") ?? undefined,
        legalEntityId: url.searchParams.get("legalEntityId") ?? undefined,
        status: statusParam as "active" | "inactive" | undefined,
        cursor: url.searchParams.get("cursor") ?? undefined
      });

      return ok({ units: result.units, nextCursor: result.nextCursor });
    } catch {
      return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    }
  });
};

/** `POST /api/v1/organization-structure/units` (Issue #749). */
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
    code: typeof body.code === "string" ? body.code : "",
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
      CREATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const result = await createOrganizationUnit(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    if (!result.ok) {
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
      if (result.reason === "duplicate_code") {
        return fail(
          409,
          "DUPLICATE_CODE",
          "An organization unit with this code already exists."
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
