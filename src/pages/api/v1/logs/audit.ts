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
  moduleKey: "logging",
  activityCode: "audit_trail",
  action: "read" as const
};

const AUDIT_EVENT_LIMIT = 100;

type AuditEventRow = {
  id: string;
  actor_tenant_user_id: string | null;
  module_key: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  severity: string;
  message: string;
  attributes: unknown;
  correlation_id: string | null;
  created_at: Date;
};

/**
 * `GET /api/v1/logs/audit` (Issue 10.1). Bearer-session auth, guarded by
 * `logging.audit_trail.read`. Reads from `awcms_mini_audit_events` (migration
 * 011) — attributes are already redacted at write time
 * (`src/modules/logging/application/audit-log.ts`), so this response never
 * needs to re-redact.
 *
 * Chosen as the concrete end-to-end correlation ID demonstration (doc 10
 * §Domain event envelope, Issue 10.1): `context.locals.correlationId`
 * (populated by `src/middleware.ts` for every request) is echoed back in
 * `ApiMeta.correlationId` on both success and error responses.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const correlationMeta = { correlationId: locals.correlationId };
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(
      400,
      "TENANT_REQUIRED",
      "Tenant header is required.",
      correlationMeta
    );
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(
      401,
      "AUTH_REQUIRED",
      "Authentication required.",
      correlationMeta
    );
  }

  const resourceType = url.searchParams.get("resourceType");
  const actionFilter = url.searchParams.get("action");
  const severityFilter = url.searchParams.get("severity");
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? decodeKeysetCursor(cursorParam) : null;

  if (cursorParam && !cursor) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "cursor is malformed.",
      correlationMeta
    );
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

      if (!context) {
        return fail(
          401,
          "AUTH_REQUIRED",
          "Session is invalid or expired.",
          correlationMeta
        );
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
        return fail(403, "ACCESS_DENIED", decision.reason, correlationMeta);
      }

      const cursorCreatedAt = cursor?.createdAt ?? null;
      const cursorId = cursor?.id ?? null;

      const rows = (await tx`
      SELECT id, actor_tenant_user_id, module_key, action, resource_type, resource_id,
             severity, message, attributes, correlation_id, created_at
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId}
        AND (${resourceType}::text IS NULL OR resource_type = ${resourceType})
        AND (${actionFilter}::text IS NULL OR action = ${actionFilter})
        AND (${severityFilter}::text IS NULL OR severity = ${severityFilter})
        AND (
          ${cursorCreatedAt}::timestamptz IS NULL
          OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ${AUDIT_EVENT_LIMIT}
    `) as AuditEventRow[];

      const nextCursor =
        rows.length === AUDIT_EVENT_LIMIT
          ? encodeKeysetCursor(
              rows[rows.length - 1]!.created_at,
              rows[rows.length - 1]!.id
            )
          : null;

      return ok(
        {
          events: rows.map((row) => ({
            id: row.id,
            actorTenantUserId: row.actor_tenant_user_id ?? undefined,
            moduleKey: row.module_key,
            action: row.action,
            resourceType: row.resource_type,
            resourceId: row.resource_id ?? undefined,
            severity: row.severity,
            message: row.message,
            attributes: row.attributes ?? undefined,
            correlationId: row.correlation_id ?? undefined,
            createdAt: row.created_at.toISOString()
          })),
          nextCursor
        },
        correlationMeta
      );
    },
    { workClass: "reporting" }
  );
};
