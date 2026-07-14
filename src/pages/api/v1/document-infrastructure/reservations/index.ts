import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { listReservations } from "../../../../../modules/document-infrastructure/application/document-number-reservation-service";
import {
  CONFIDENTIAL_READ_PERMISSION_KEY,
  RESTRICTED_READ_PERMISSION_KEY
} from "../../../../../modules/document-infrastructure/domain/document";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "reservations",
  action: "read" as const
};

/**
 * `GET /api/v1/document-infrastructure/reservations?sequenceId=&status=`
 * (Issue #751). Reservations already committed to a
 * `confidential`/`restricted` document are filtered by confidentiality-
 * tier clearance (Issue #787 fast-follow) — see `document-number-
 * reservation-service.ts`'s `listReservations` doc comment.
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  const allowedStatuses = ["reserved", "committed", "canceled"];
  if (statusParam && !allowedStatuses.includes(statusParam)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `status must be one of: ${allowedStatuses.join(", ")}.`
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

    const access = {
      canReadConfidential: auth.grantedPermissionKeys.has(
        CONFIDENTIAL_READ_PERMISSION_KEY
      ),
      canReadRestricted: auth.grantedPermissionKeys.has(
        RESTRICTED_READ_PERMISSION_KEY
      )
    };

    const reservations = await listReservations(tx, tenantId, access, {
      sequenceId: url.searchParams.get("sequenceId") ?? undefined,
      status: statusParam as "reserved" | "committed" | "canceled" | undefined
    });

    return ok({ reservations });
  });
};
