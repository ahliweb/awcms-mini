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
  fetchSocialPublishJobById,
  listSocialPublishAttemptsForJob
} from "../../../../../modules/social-publishing/application/social-publish-job-directory";

const READ_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "jobs",
  action: "read" as const
};

/** `GET /api/v1/social-publishing/jobs/{id}` (Issue #643) — job detail with its full attempt history embedded (issue acceptance criterion: "Admin UI shows accounts, rules, jobs, attempts, external IDs, and safe error messages"). */
export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Job id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
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

    if (!auth.allowed) {
      return auth.denied;
    }

    const job = await fetchSocialPublishJobById(tx, tenantId, id);

    if (!job) {
      return fail(404, "RESOURCE_NOT_FOUND", "Social publish job not found.");
    }

    const attempts = await listSocialPublishAttemptsForJob(tx, tenantId, id);

    return ok({ ...job, attempts });
  });
};
