import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { generateDuplicateCandidatesForProfile } from "../../../../../../modules/profile-identity/application/duplicate-candidate-directory";
import { fetchPartyById } from "../../../../../../modules/profile-identity/application/party-directory";

const ANALYZE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "duplicate_candidates",
  action: "analyze" as const
};

/**
 * `POST /api/v1/profiles/{id}/duplicate-candidates/scan` (Issue #748) —
 * on-demand duplicate-candidate scan for this profile against every other
 * active profile in the SAME tenant. Deterministic (shared identifier
 * value) + heuristic (name similarity) matches are upserted; a
 * `not_duplicate` decision on an existing candidate is never overwritten.
 * Never auto-merges — a candidate is only ever an input to a human-
 * initiated merge request.
 */
export const POST: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
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
      ANALYZE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const profile = await fetchPartyById(tx, tenantId, profileId);

    if (!profile) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    const result = await generateDuplicateCandidatesForProfile(
      tx,
      tenantId,
      profileId
    );

    return ok(result);
  });
};
