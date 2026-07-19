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
import { resolveTenantEntitlement } from "../../../../modules/tenant-entitlement/application/entitlement-resolution";

const READ_GUARD = {
  moduleKey: "tenant_entitlement",
  activityCode: "entitlement",
  action: "read" as const
};

/**
 * `GET /api/v1/tenant-entitlement/effective` (Issue #871) — the DETERMINISTIC,
 * EXPLAINABLE effective entitlement (features/modules/quotas + source) for the
 * CURRENT tenant, optionally as-of `?at=<ISO timestamp>`. Operates ONLY on the
 * current tenant's RLS context (ADR-0022 §6 — no cross-tenant path param, no
 * soft super-tenant). Bounded resolution (no per-request N+1 catalog query).
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const atParam = new URL(request.url).searchParams.get("at");
  if (atParam !== null && Number.isNaN(Date.parse(atParam))) {
    return fail(400, "VALIDATION_ERROR", "at must be an ISO 8601 timestamp.");
  }
  const now = atParam !== null ? new Date(atParam) : new Date();

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

    const deps = {
      catalogPort: createServiceCatalogReadPort(tx),
      moduleDescriptors: listModules()
    };
    const entitlement = await resolveTenantEntitlement(tx, tenantId, deps, now);
    return ok({ entitlement });
  });
};
