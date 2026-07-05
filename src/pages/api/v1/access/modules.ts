import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../modules/identity-access/application/session-lookup";
import { resolveTenantContext } from "../../../../modules/identity-access/application/auth-context";

export const GET: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

    if (!context) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const rows = await tx`
      SELECT module_key, activity_code, action, description
      FROM awcms_mini_permissions
      ORDER BY module_key, activity_code, action
    `;

    type PermissionRow = {
      module_key: string;
      activity_code: string;
      action: string;
      description: string | null;
    };

    return ok({
      modules: rows.map((row: PermissionRow) => ({
        moduleKey: row.module_key,
        activityCode: row.activity_code,
        action: row.action,
        description: row.description ?? undefined
      }))
    });
  });
};
