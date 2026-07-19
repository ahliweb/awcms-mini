import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../../lib/auth/session-token";
import { listModules } from "../../../../../../../../modules";
import { resolveServiceCatalogKeyRegistry } from "../../../../../../../../modules/service-catalog/domain/key-registry";
import { validateVersion } from "../../../../../../../../modules/service-catalog/application/plan-directory";

const UPDATE_GUARD = {
  moduleKey: "service_catalog",
  activityCode: "plans",
  action: "update" as const
};

/**
 * `POST /api/v1/service-catalog/plans/{planKey}/versions/{version}/validate`
 * (Issue #870) — the explicit "validate" lifecycle step. Non-mutating: runs
 * the full publish-time validation (bounds, exact amounts, fail-closed key
 * resolution) and returns the errors without changing state. No
 * `Idempotency-Key` (nothing is written).
 */
export const POST: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const planKey = params.planKey ?? "";
  const version = Number(params.version);
  if (!Number.isInteger(version) || version < 1) {
    return fail(400, "VALIDATION_ERROR", "version must be a positive integer.");
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
      UPDATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const registry = resolveServiceCatalogKeyRegistry(listModules());
    const result = await validateVersion(tx, planKey, version, registry);

    if (!result.ok) {
      return fail(404, "RESOURCE_NOT_FOUND", "Plan version not found.");
    }

    return ok({
      valid: result.valid,
      errors: result.valid ? [] : result.errors
    });
  });
};
