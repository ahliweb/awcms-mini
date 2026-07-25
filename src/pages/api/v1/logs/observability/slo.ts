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
import { listModules } from "../../../../../modules";
import { collectSloDescriptors } from "../../../../../modules/logging/domain/slo-registry";
import { toSafeObjectiveViews } from "../../../../../modules/logging/domain/slo-safe-view";

const GUARD_REQUEST = {
  moduleKey: "logging",
  activityCode: "observability",
  action: "read" as const
};

/**
 * `GET /api/v1/logs/observability/slo` (Issue #930, epic #868 SaaS control
 * plane). The authorized catalog of service-level objectives every module
 * declared in its own `module.ts` — what an operator needs in order to know
 * which objectives exist, what each one promises, what severities it can
 * reach, and where the runbook is.
 *
 * Same auth shape as its sibling `dependency-health` in this directory:
 * tenant header + bearer session + the `logging.observability.read`
 * permission, with the decision recorded either way.
 *
 * ## Why the response is built by `toSafeObjectiveViews` and not from the
 * descriptors directly
 *
 * #930 requires that alert/health endpoints "reveal safe status only, never
 * sensitive configuration values". Numeric thresholds and dwell times are
 * exactly that class of value: they say how far a degradation can go, and
 * for how long, before anyone is told. `slo-safe-view.ts` builds the
 * response from an explicit field allow-list, so a field added to
 * `ServiceLevelObjectiveDescriptor` later cannot leak here by default — see
 * that file for the full reasoning on each withheld field.
 *
 * This route reads the CODE registry (`listModules()`), not the database, so
 * it is deliberately not tenant-data-dependent — but it still runs inside
 * `withTenant`, because the caller's session and permission must be resolved
 * against their own tenant like any other authorized read.
 *
 * Live objective STATE (which objectives are currently in breach) is not
 * served here yet: the fleet-wide collectors that compute those signals land
 * with the scheduled control-plane jobs. This endpoint is the catalog half.
 */
export const GET: APIRoute = async ({ request, locals }) => {
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

      const objectives = toSafeObjectiveViews(
        collectSloDescriptors(listModules())
      );

      return ok(
        {
          generatedAt: now.toISOString(),
          objectiveCount: objectives.length,
          objectives
        },
        correlationMeta
      );
    },
    { workClass: "reporting" }
  );
};
