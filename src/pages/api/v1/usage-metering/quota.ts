import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { listModules } from "../../../../modules";
import { createServiceCatalogReadPort } from "../../../../modules/service-catalog/application/service-catalog-read-port-adapter";
import { createEffectiveEntitlementPort } from "../../../../modules/tenant-entitlement/application/effective-entitlement-port-adapter";
import { buildContractRegistry } from "../../../../modules/usage-metering/application/meter-registry";
import { createUsageAggregatePort } from "../../../../modules/usage-metering/application/usage-aggregate-adapter";

const READ_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "quota",
  action: "read" as const
};

/**
 * `GET /api/v1/usage-metering/quota?meterKey=` (Issue #875) — the FAIL-CLOSED
 * effective quota decision for a meter in the CURRENT tenant: the #871
 * entitlement limit combined with the AUTHORITATIVE live usage recompute over
 * the immutable events (never a stale cache). A hard quota denies when usage is
 * unavailable. Entitlement != permission — a positive decision is a commercial
 * fact, never an authorization. Current tenant RLS only.
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const meterKey = new URL(request.url).searchParams.get("meterKey");
  if (!meterKey) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "meterKey query parameter is required."
    );
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      READ_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const registry = buildContractRegistry(listModules());
    const entitlementPort = createEffectiveEntitlementPort(tx, tenantId, {
      catalogPort: createServiceCatalogReadPort(tx),
      moduleDescriptors: listModules()
    });
    const aggregatePort = createUsageAggregatePort(
      tx,
      tenantId,
      registry,
      entitlementPort
    );
    const decision = await aggregatePort.getQuotaDecision(meterKey);
    return ok({ decision });
  });
};
