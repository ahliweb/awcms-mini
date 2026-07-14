import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { listReconciliationReports } from "../../../../../../modules/data-exchange/application/reconciliation-service";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "reconciliation",
  action: "read" as const
};

/** `GET /api/v1/data-exchange/reconciliation/{subjectType}/{subjectId}` (Issue #752) — reconciliation reports for an import batch or export job, newest first. */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const subjectType = params.subjectType;
  const subjectId = params.subjectId;
  if (subjectType !== "import" && subjectType !== "export") {
    return fail(
      400,
      "VALIDATION_ERROR",
      'subjectType must be "import" or "export".'
    );
  }
  if (!subjectId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "subjectId path parameter is required."
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

    const reports = await listReconciliationReports(
      tx,
      tenantId,
      subjectType,
      subjectId
    );

    return ok({ reports });
  });
};
