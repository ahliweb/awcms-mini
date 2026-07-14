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
  createOrganizationUnitAssignment,
  listOrganizationUnitAssignments
} from "../../../../../modules/organization-structure/application/organization-unit-assignment-service";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "assignments",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "assignments",
  action: "create" as const
};

const VALID_STATUSES = new Set(["active", "ended"]);

/** `GET /api/v1/organization-structure/assignments?organizationUnitId=&tenantUserId=&status=&asOf=` (Issue #749). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return fail(400, "VALIDATION_ERROR", "status must be active or ended.");
  }

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

    const assignments = await listOrganizationUnitAssignments(tx, tenantId, {
      organizationUnitId:
        url.searchParams.get("organizationUnitId") ?? undefined,
      tenantUserId: url.searchParams.get("tenantUserId") ?? undefined,
      status: statusParam as "active" | "ended" | undefined,
      asOf
    });

    return ok({ assignments });
  });
};

/** `POST /api/v1/organization-structure/assignments` (Issue #749). */
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
    organizationUnitId:
      typeof body.organizationUnitId === "string"
        ? body.organizationUnitId
        : "",
    tenantUserId:
      typeof body.tenantUserId === "string" ? body.tenantUserId : "",
    positionLabel:
      typeof body.positionLabel === "string" ? body.positionLabel : null,
    effectiveFrom:
      typeof body.effectiveFrom === "string"
        ? new Date(body.effectiveFrom)
        : new Date(),
    effectiveTo:
      typeof body.effectiveTo === "string" ? new Date(body.effectiveTo) : null,
    reason: typeof body.reason === "string" ? body.reason : null
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

    const result = await createOrganizationUnitAssignment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "unit_not_found") {
        return fail(404, "NOT_FOUND", "Organization unit not found.");
      }
      if (result.reason === "tenant_user_not_found") {
        return fail(
          422,
          "TENANT_USER_INVALID",
          "tenantUserId does not reference an existing user for this tenant."
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

    return ok({ assignment: result.assignment });
  });
};
