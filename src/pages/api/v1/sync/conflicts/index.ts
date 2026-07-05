import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../../modules/identity-access/domain/access-control";

const GUARD_REQUEST = {
  moduleKey: "sync_storage",
  activityCode: "conflict_resolution",
  action: "read" as const
};

const MAX_RESULTS = 50;

export const GET: APIRoute = async ({ request, url }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const statusFilter = url.searchParams.get("status");
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

    const rows =
      statusFilter === "open" || statusFilter === "resolved"
        ? await tx`
            SELECT id, node_id, batch_id, aggregate_type, aggregate_id, conflict_type,
                   payload_json, status, resolution, resolution_note, resolved_by, resolved_at, created_at
            FROM awcms_mini_sync_conflicts
            WHERE tenant_id = ${tenantId} AND status = ${statusFilter}
            ORDER BY created_at DESC
            LIMIT ${MAX_RESULTS}
          `
        : await tx`
            SELECT id, node_id, batch_id, aggregate_type, aggregate_id, conflict_type,
                   payload_json, status, resolution, resolution_note, resolved_by, resolved_at, created_at
            FROM awcms_mini_sync_conflicts
            WHERE tenant_id = ${tenantId}
            ORDER BY created_at DESC
            LIMIT ${MAX_RESULTS}
          `;

    type ConflictRow = {
      id: string;
      node_id: string;
      batch_id: string;
      aggregate_type: string;
      aggregate_id: string;
      conflict_type: string;
      payload_json: unknown;
      status: string;
      resolution: string | null;
      resolution_note: string | null;
      resolved_by: string | null;
      resolved_at: Date | null;
      created_at: Date;
    };

    return ok({
      conflicts: (rows as ConflictRow[]).map((row) => ({
        id: row.id,
        nodeId: row.node_id,
        batchId: row.batch_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        conflictType: row.conflict_type,
        payload: row.payload_json,
        status: row.status,
        resolution: row.resolution ?? undefined,
        resolutionNote: row.resolution_note ?? undefined,
        resolvedBy: row.resolved_by ?? undefined,
        resolvedAt: row.resolved_at?.toISOString(),
        createdAt: row.created_at.toISOString()
      }))
    });
  });
};
