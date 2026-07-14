import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { listSequenceHistory } from "../../../../../modules/document-infrastructure/application/document-number-sequence-definition-service";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "sequences",
  action: "read" as const
};

/** `GET /api/v1/document-infrastructure/sequences/history?scopeType=&scopeId=&sequenceKey=` (Issue #751) — full effective-dated history (open + closed definitions) for one scope. */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const scopeType = url.searchParams.get("scopeType");
  const sequenceKey = url.searchParams.get("sequenceKey");
  if (!scopeType || !sequenceKey) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "scopeType and sequenceKey query parameters are required."
    );
  }
  const scopeId = url.searchParams.get("scopeId");

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

    const history = await listSequenceHistory(tx, tenantId, {
      scopeType,
      scopeId,
      sequenceKey
    });

    return ok({ history });
  });
};
