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
import {
  getDatabaseCircuitBreaker,
  getProviderCircuitBreakerFamilyStates
} from "../../../../../lib/database/circuit-breaker";
import { getWorkClassSaturation } from "../../../../../lib/database/work-class";

const GUARD_REQUEST = {
  moduleKey: "logging",
  activityCode: "observability",
  action: "read" as const
};

/**
 * `GET /api/v1/logs/observability/dependency-health` (Issue #698, epic #679
 * platform-hardening — "operational proof" wave). The AUTHORIZED
 * counterpart to the public `/api/v1/health` (liveness) and
 * `/api/v1/database/pool/health` (unauthenticated local-dependency
 * aggregate) endpoints — this one requires a valid session + the
 * `logging.observability.read` permission, and is the only endpoint that
 * distinguishes "local dependencies" (the database this instance always
 * depends on) from "optional external providers" (email, object storage,
 * Cloudflare DNS, SSO/OIDC, ...) per the issue's acceptance criterion.
 *
 * Deliberately does NOT re-ping the database with its own `SELECT 1` (like
 * `/database/pool/health` does) — by the time this handler runs, `withTenant`
 * has already executed a real query on this connection to resolve the
 * caller's session, which is itself proof of reachability; re-pinging would
 * just be a redundant round trip on the same connection.
 *
 * `optionalProviders` never exposes a raw circuit-breaker registry key
 * (which can embed a tenant id for tenant-scoped SSO providers, Issue #610)
 * — `getProviderCircuitBreakerFamilyStates` (circuit-breaker.ts) already
 * aggregates down to the bounded, code-defined provider "family" via the
 * same `deriveProviderFamilyLabel` the metrics layer uses, so this endpoint
 * and the metrics labels stay consistent by construction.
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

      const breaker = getDatabaseCircuitBreaker();
      const circuitState = breaker.getState(now);
      const saturation = getWorkClassSaturation();
      const anyClassSaturated = saturation.some(
        (entry) => entry.active >= entry.max && entry.queued > 0
      );

      const databaseStatus: "healthy" | "degraded" | "unhealthy" =
        circuitState === "open"
          ? "unhealthy"
          : circuitState === "half_open" || anyClassSaturated
            ? "degraded"
            : "healthy";

      const optionalProviders = getProviderCircuitBreakerFamilyStates(now).map(
        (entry) => ({
          family: entry.family,
          circuitBreakerState: entry.state
        })
      );

      return ok(
        {
          generatedAt: now.toISOString(),
          localDependencies: [
            {
              name: "database",
              status: databaseStatus,
              circuitBreakerState: circuitState,
              workClasses: saturation
            }
          ],
          optionalProviders
        },
        correlationMeta
      );
    },
    { workClass: "reporting" }
  );
};
