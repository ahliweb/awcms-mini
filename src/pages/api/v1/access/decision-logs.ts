import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../modules/identity-access/domain/access-control";
import {
  decodeKeysetCursor,
  encodeKeysetCursor
} from "../../../../modules/_shared/keyset-pagination";

const GUARD_REQUEST = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "read" as const
};

const MAX_RESULTS = 50;

type DecisionLogRow = {
  id: string;
  tenant_user_id: string | null;
  module_key: string;
  activity_code: string;
  action: string;
  decision: "allow" | "deny";
  reason: string;
  matched_policy: string | null;
  created_at: Date;
};

export const GET: APIRoute = async ({ request, url }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? decodeKeysetCursor(cursorParam) : null;

  if (cursorParam && !cursor) {
    return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

    if (!context) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const grantedPermissionKeys = await fetchGrantedPermissionKeys(
      tx,
      tenantId,
      context.tenantUserId
    );
    const decision = evaluateAccess(
      context,
      GUARD_REQUEST,
      grantedPermissionKeys
    );

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      GUARD_REQUEST,
      decision
    );

    if (!decision.allowed) {
      return fail(403, "ACCESS_DENIED", decision.reason);
    }

    const rows = (
      cursor
        ? await tx`
          SELECT id, tenant_user_id, module_key, activity_code, action, decision, reason, matched_policy, created_at
          FROM awcms_mini_abac_decision_logs
          WHERE tenant_id = ${tenantId}
            AND (created_at, id) < (${cursor.createdAt}, ${cursor.id})
          ORDER BY created_at DESC, id DESC
          LIMIT ${MAX_RESULTS}
        `
        : await tx`
          SELECT id, tenant_user_id, module_key, activity_code, action, decision, reason, matched_policy, created_at
          FROM awcms_mini_abac_decision_logs
          WHERE tenant_id = ${tenantId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${MAX_RESULTS}
        `
    ) as DecisionLogRow[];

    const nextCursor =
      rows.length === MAX_RESULTS
        ? encodeKeysetCursor(
            rows[rows.length - 1]!.created_at,
            rows[rows.length - 1]!.id
          )
        : null;

    return ok({
      decisionLogs: rows.map((row) => ({
        id: row.id,
        tenantUserId: row.tenant_user_id ?? undefined,
        moduleKey: row.module_key,
        activityCode: row.activity_code,
        action: row.action,
        decision: row.decision,
        reason: row.reason,
        matchedPolicy: row.matched_policy ?? undefined,
        createdAt: row.created_at.toISOString()
      })),
      nextCursor
    });
  });
};
