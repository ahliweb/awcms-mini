import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { buildOrganizationUnitTree } from "../../../../../modules/organization-structure/application/organization-unit-hierarchy-service";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "hierarchy",
  action: "read" as const
};

/** `GET /api/v1/organization-structure/hierarchy/tree?rootUnitId=&asOf=` (Issue #749) — nested tree, current or as-of a given timestamp. */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

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

    const tree = await buildOrganizationUnitTree(
      tx,
      tenantId,
      url.searchParams.get("rootUnitId") ?? null,
      asOf
    );

    return ok({ tree });
  });
};
