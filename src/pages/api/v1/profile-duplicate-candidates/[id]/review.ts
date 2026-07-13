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
import { reviewDuplicateCandidate } from "../../../../../modules/profile-identity/application/duplicate-candidate-directory";

const REVIEW_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "duplicate_candidates",
  action: "update" as const
};

type ReviewBody = { decision?: unknown; notes?: unknown };

const VALID_DECISIONS = ["confirmed_duplicate", "not_duplicate"];

/**
 * `POST /api/v1/profile-duplicate-candidates/{id}/review` (Issue #748) —
 * human review decision on a duplicate candidate: `confirmed_duplicate`
 * (a human agrees these are the same party — still does NOT merge
 * anything by itself, only a separate merge request does that) or
 * `not_duplicate` (false positive — this decision sticks; a later scan
 * never overwrites a reviewed candidate, see
 * `duplicate-candidate-directory.ts`'s upsert). `404` if the candidate
 * does not exist or has already been reviewed (re-review is not
 * supported — a fresh scan creates a new candidate row if warranted).
 */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const candidateId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!candidateId) {
    return fail(400, "VALIDATION_ERROR", "Candidate id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<ReviewBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const decision = bodyRead.value?.decision;

  if (typeof decision !== "string" || !VALID_DECISIONS.includes(decision)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `decision must be one of: ${VALID_DECISIONS.join(", ")}.`
    );
  }

  const notes = bodyRead.value?.notes;

  if (notes !== undefined && typeof notes !== "string") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "notes must be a string when provided."
    );
  }

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
      REVIEW_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const reviewed = await reviewDuplicateCandidate(
      tx,
      tenantId,
      auth.context.tenantUserId,
      candidateId,
      decision as "confirmed_duplicate" | "not_duplicate",
      (notes as string | undefined)?.trim() || null,
      correlationId
    );

    if (!reviewed) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "Duplicate candidate not found or already reviewed."
      );
    }

    return ok(reviewed);
  });
};
