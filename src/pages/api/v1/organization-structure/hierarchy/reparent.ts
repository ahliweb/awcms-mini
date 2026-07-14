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
import { reparentUnit } from "../../../../../modules/organization-structure/application/organization-unit-hierarchy-service";

const IDEMPOTENCY_SCOPE = "organization_structure_hierarchy_reparent";

const ASSIGN_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "hierarchy",
  action: "assign" as const
};

type ReparentBody = {
  organizationUnitId?: unknown;
  parentOrganizationUnitId?: unknown;
  reason?: unknown;
};

/**
 * `POST /api/v1/organization-structure/hierarchy/reparent` (Issue #749) —
 * create or change an organization unit's current parent edge.
 * `parentOrganizationUnitId: null` moves the unit to top-level. High-risk
 * mutation: requires `Idempotency-Key` (structurally similar to this
 * repo's existing "high-risk mutation needing idempotency" bar — transfer
 * approve, workflow decision), audited `critical`, and rejects self-
 * parent/cycle/cross-tenant references (`application/organization-unit-
 * hierarchy-service.ts`'s `reparentUnit`, the sole write path against the
 * hierarchy table).
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

  const bodyRead = await readJsonBody<ReparentBody>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const organizationUnitId =
    typeof body.organizationUnitId === "string" ? body.organizationUnitId : "";
  if (!organizationUnitId) {
    return fail(400, "VALIDATION_ERROR", "organizationUnitId is required.");
  }

  const parentOrganizationUnitId =
    typeof body.parentOrganizationUnitId === "string"
      ? body.parentOrganizationUnitId
      : null;
  const reason = typeof body.reason === "string" ? body.reason : null;

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
      ASSIGN_GUARD
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

    const result = await reparentUnit(
      tx,
      tenantId,
      auth.context.tenantUserId,
      organizationUnitId,
      parentOrganizationUnitId,
      reason,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "unit_not_found") {
        return fail(404, "NOT_FOUND", "Organization unit not found.");
      }
      if (result.reason === "parent_not_found") {
        return fail(
          422,
          "PARENT_INVALID",
          "parentOrganizationUnitId does not reference an existing organization unit for this tenant."
        );
      }
      return fail(
        422,
        "HIERARCHY_INVALID",
        result.message,
        {},
        {
          validationReason: result.validationReason
        }
      );
    }

    const successResponse = ok({ edge: result.edge });
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
