import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { listModules } from "../../../../../modules";
import { collectExchangeDescriptors } from "../../../../../modules/data-exchange/domain/exchange-registry";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "descriptors",
  action: "read" as const
};

/** `GET /api/v1/data-exchange/descriptors` (Issue #752) — the module-contributed exchange descriptor registry (code-declared metadata only, never row contents). */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

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

    const descriptors = collectExchangeDescriptors(listModules());

    return ok({ descriptors });
  });
};
