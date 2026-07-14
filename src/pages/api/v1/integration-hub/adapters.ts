import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { INTEGRATION_ADAPTERS } from "../../../../modules/integration-hub/infrastructure/adapter-registry";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "adapters",
  action: "read" as const
};

/** `GET /api/v1/integration-hub/adapters` — the static, code-declared adapter registry (metadata only — no secret/credential fields exist on this shape at all). */
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

    const adapters = INTEGRATION_ADAPTERS.map((adapter) => ({
      adapterKey: adapter.adapterKey,
      displayName: adapter.displayName,
      direction: adapter.direction,
      dataSensitivity: adapter.dataSensitivity,
      defaultTimeoutMs: adapter.defaultTimeoutMs,
      retryClassification: adapter.retryClassification
    }));

    return ok({ adapters });
  });
};
