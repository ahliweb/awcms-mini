import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { listSocialPublishJobs } from "../../../../../modules/social-publishing/application/social-publish-job-directory";

const READ_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "jobs",
  action: "read" as const
};

const VALID_STATUSES = new Set([
  "pending",
  "requires_approval",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
  "skipped",
  "rate_limited",
  "needs_reauth"
]);

/** `GET /api/v1/social-publishing/jobs?status=` (Issue #643) — bounded list (max 200), optional status filter. Full keyset pagination is a documented follow-up (not implemented in this foundation issue — same "bounded LIMIT list, no pagination yet" precedent `ad-placement-directory.ts`'s admin listing set). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const statusParam = url.searchParams.get("status") ?? undefined;

  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "status is not a recognized job status."
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

    if (!auth.allowed) {
      return auth.denied;
    }

    const jobs = await listSocialPublishJobs(tx, tenantId, {
      status: statusParam
    });

    return ok({ jobs });
  });
};
