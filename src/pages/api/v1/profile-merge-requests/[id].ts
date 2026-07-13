import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { fetchMergeRequestById } from "../../../../modules/profile-identity/application/merge-workflow";

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "profile_merge",
  action: "read" as const
};

/** `GET /api/v1/profile-merge-requests/{id}` (Issue #748) — detail, including the field-conflict and reference-impact snapshots for review. */
export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const mergeRequestId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!mergeRequestId) {
    return fail(400, "VALIDATION_ERROR", "Merge request id is required.");
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

    const mergeRequest = await fetchMergeRequestById(
      tx,
      tenantId,
      mergeRequestId
    );

    if (!mergeRequest) {
      return fail(404, "RESOURCE_NOT_FOUND", "Merge request not found.");
    }

    return ok(mergeRequest);
  });
};
