import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { listDuplicateCandidates } from "../../../../modules/profile-identity/application/duplicate-candidate-directory";

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "duplicate_candidates",
  action: "read" as const
};

const VALID_STATUSES = ["pending", "confirmed_duplicate", "not_duplicate"];

/**
 * `GET /api/v1/profile-duplicate-candidates` (Issue #748) — tenant-wide
 * duplicate-candidate list. `?status=` (`pending`/`confirmed_duplicate`/
 * `not_duplicate`) and `?profileId=` (either side of the pair) both
 * optional filters. Separate top-level path (not nested under
 * `/profiles/`) so it never collides with `/profiles/{id}`'s dynamic
 * route segment.
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const statusParam = url.searchParams.get("status");

  if (statusParam !== null && !VALID_STATUSES.includes(statusParam)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `status must be one of: ${VALID_STATUSES.join(", ")}.`
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

    const items = await listDuplicateCandidates(tx, tenantId, {
      status: statusParam ?? undefined,
      profileId: url.searchParams.get("profileId") ?? undefined
    });

    return ok({ items });
  });
};
