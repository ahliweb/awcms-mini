import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  listHierarchyHistoryForUnit,
  resolveAncestryChains
} from "../../../../../../modules/organization-structure/application/organization-unit-hierarchy-service";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "hierarchy",
  action: "read" as const
};

/** `GET /api/v1/organization-structure/hierarchy/units/{id}?asOf=&history=` (Issue #749) — ancestor/descendant chains (current or as-of), plus full effective-dated history when `history=1`. */
export const GET: APIRoute = async ({ request, cookies, params, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const unitId = params.id;
  if (!unitId) return fail(400, "VALIDATION_ERROR", "Unit id is required.");

  const asOfParam = url.searchParams.get("asOf");
  let asOf: Date | null = null;
  if (asOfParam) {
    asOf = new Date(asOfParam);
    if (Number.isNaN(asOf.getTime())) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "asOf must be a valid ISO timestamp."
      );
    }
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
    if (!auth.allowed) return auth.denied;

    const chains = await resolveAncestryChains(tx, tenantId, unitId, asOf);
    const history =
      url.searchParams.get("history") === "1"
        ? await listHierarchyHistoryForUnit(tx, tenantId, unitId)
        : undefined;

    return ok({
      organizationUnitId: unitId,
      ancestorUnitIds: chains.ancestorUnitIds,
      descendantUnitIds: chains.descendantUnitIds,
      history
    });
  });
};
