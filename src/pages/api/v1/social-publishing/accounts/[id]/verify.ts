import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { log } from "../../../../../../lib/logging/logger";
import { verifySocialAccountConnection } from "../../../../../../modules/social-publishing/application/social-account-verification";

const CONNECT_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "accounts",
  action: "connect" as const
};

/**
 * `POST /api/v1/social-publishing/accounts/{id}/verify` (Issue #644 —
 * `verify_meta_connection`, provider-neutral in shape). Gated by
 * `accounts.connect` — same permission as connect/reconnect (this touches
 * the same credential, though read-only), not a new permission (matches
 * Issue #643's "reuse the fixed 10-permission list" convention). Not an
 * idempotency-keyed mutation — same precedent as `POST
 * /api/v1/modules/{moduleKey}/health/check`, an on-demand diagnostic action
 * with no destructive side effect, only ever updates `last_verified_at`/
 * flips `connection_status` to `needs_reauth` on an already-invalid finding.
 *
 * The real provider call (`adapter.verifyCredentials`) happens entirely
 * OUTSIDE any DB transaction inside
 * `social-account-verification.ts`'s `verifySocialAccountConnection` — this
 * route itself never opens a transaction spanning the network call. The
 * ABAC check below runs in its own short transaction, separate from the
 * (also short) transaction `verifySocialAccountConnection` opens
 * internally to fetch the account row — a deliberate two-round-trip
 * tradeoff (rather than threading one shared `tx` through both) to keep
 * that function's own phase boundaries (fetch / call / persist) fully
 * self-contained and reusable by a future non-HTTP caller; the extra
 * read-only round trip is negligible for a low-frequency admin action.
 */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Account id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  const auth = await withTenant(sql, tenantId, (tx) =>
    authorizeInTransaction(tx, tenantId, tokenHash, now, CONNECT_GUARD)
  );

  if (!auth.allowed) {
    return auth.denied;
  }

  const outcome = await verifySocialAccountConnection(
    sql,
    tenantId,
    id,
    process.env,
    correlationId
  );

  log("info", "social_publishing.account.verify_attempted", {
    correlationId,
    tenantId,
    moduleKey: "social_publishing",
    socialAccountId: id,
    status: outcome.status
  });

  switch (outcome.status) {
    case "not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Social account not found.");
    case "provider_not_registered":
      return fail(
        422,
        "PROVIDER_NOT_REGISTERED",
        `No provider adapter is registered for "${outcome.providerKey}".`
      );
    case "unsupported_account_type":
      return fail(
        422,
        "SOCIAL_ACCOUNT_UNSUPPORTED_TYPE",
        `Provider "${outcome.providerKey}" does not support account type "${outcome.providerAccountType}".`
      );
    case "circuit_breaker_open":
      return fail(
        503,
        "PROVIDER_ERROR",
        "The provider's circuit breaker is currently open; try again shortly."
      );
    case "invalid":
      return fail(
        409,
        "SOCIAL_ACCOUNT_NEEDS_REAUTH",
        "This account's connection is no longer valid and must be reconnected.",
        {},
        { reason: outcome.reason }
      );
    case "valid":
      return ok(outcome.account);
    default:
      return fail(500, "INTERNAL_ERROR", "Unexpected verification outcome.");
  }
};
