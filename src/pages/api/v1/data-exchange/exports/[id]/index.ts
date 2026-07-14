import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { getExportJobById } from "../../../../../../modules/data-exchange/application/export-job-directory";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "exports",
  action: "read" as const
};

/** `GET /api/v1/data-exchange/exports/{id}` (Issue #752) — job status/manifest (file content is never returned by this endpoint, see `download.ts`). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const jobId = params.id;
  if (!jobId)
    return fail(400, "VALIDATION_ERROR", "id path parameter is required.");

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

    const job = await getExportJobById(tx, tenantId, jobId);
    if (!job) return fail(404, "NOT_FOUND", "Export job not found.");

    return ok({ job });
  });
};
