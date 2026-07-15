import type { AstroCookies } from "astro";

import { fail } from "../../_shared/api-response";
import type { BusinessScopeHierarchyPort } from "../../_shared/ports/business-scope-hierarchy-port";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../lib/auth/ssr-session";
import type { AccessRequest, TenantContext } from "../domain/access-control";
import { evaluateAccess, isHighRiskAction } from "../domain/access-control";
import {
  fetchGrantedPermissionKeys,
  resolveModuleEnabled,
  resolveTenantContext
} from "./auth-context";
import { recordDecisionLog } from "./decision-log";
import { checkHighRiskSoDConflicts } from "./high-risk-sod-guard";
import { extractBearerToken } from "./session-lookup";

/**
 * Resolves the tenant id + session token an endpoint should authenticate with,
 * accepting EITHER the bearer/tenant headers (API clients) OR the httpOnly SSR
 * cookies (the admin UI, which cannot read its own httpOnly session token from
 * JavaScript). Headers take priority; cookies are the fallback — exactly the
 * precedence `POST /auth/logout` already uses (`src/pages/api/v1/auth/logout.ts`).
 * Cookie-authenticated mutations are still CSRF-safe because Astro's built-in
 * `security.checkOrigin` guard is on for SSR (see identity-access/README.md).
 */
export function resolveAuthInputs(
  request: Request,
  cookies: AstroCookies
): { tenantId: string | null; token: string | null } {
  const tenantId =
    request.headers.get("x-awcms-mini-tenant-id") ??
    cookies.get(TENANT_COOKIE_NAME)?.value ??
    null;

  const token =
    extractBearerToken(request.headers.get("authorization")) ??
    cookies.get(SESSION_COOKIE_NAME)?.value ??
    null;

  return { tenantId, token };
}

export type AuthorizeResult =
  | {
      allowed: true;
      context: TenantContext;
      grantedPermissionKeys: Set<string>;
    }
  | { allowed: false; denied: Response };

/**
 * Runs the full guard chain inside an existing tenant transaction: resolve the
 * session context → check the guard's module is enabled for this tenant
 * (Issue #515 — a disabled module must actually block every endpoint it
 * owns, not just look disabled in the UI) → fetch granted permission keys →
 * evaluate ABAC (default deny, deny overrides allow) → record the decision
 * log. Returns the authorized context on allow, or a ready-to-return `fail()`
 * Response (401/403) on deny. This is the same chain the existing access
 * endpoints inline; it is centralized here so every guarded endpoint stays
 * consistent, always enforces tenant module state, and always records a
 * decision log.
 *
 * `options.hierarchyPort` (Issue #802) is OPTIONAL and forwarded verbatim to
 * `checkHighRiskSoDConflicts` for hierarchy-aware `same_scope_only` SoD
 * matching — see that function's own header for why this must stay
 * optional (this file is imported by ~124 route files, only one of which,
 * `revoke.ts`, has any hierarchy port to offer today). Every existing
 * 5-argument call site is unaffected.
 */
export async function authorizeInTransaction(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  guard: AccessRequest,
  options?: { hierarchyPort?: BusinessScopeHierarchyPort }
): Promise<AuthorizeResult> {
  const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

  if (!context) {
    return {
      allowed: false,
      denied: fail(401, "AUTH_REQUIRED", "Session is invalid or expired.")
    };
  }

  const moduleEnabled = await resolveModuleEnabled(
    tx,
    tenantId,
    guard.moduleKey
  );

  if (!moduleEnabled) {
    const decision = {
      allowed: false,
      reason: "Module is disabled for this tenant.",
      matchedPolicy: "module_disabled"
    };

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      guard,
      decision
    );

    return {
      allowed: false,
      denied: fail(403, "MODULE_DISABLED", decision.reason)
    };
  }

  const grantedPermissionKeys = await fetchGrantedPermissionKeys(
    tx,
    tenantId,
    context.tenantUserId
  );
  const decision = evaluateAccess(context, guard, grantedPermissionKeys);

  await recordDecisionLog(tx, tenantId, context.tenantUserId, guard, decision);

  if (!decision.allowed) {
    return {
      allowed: false,
      denied: fail(403, "ACCESS_DENIED", decision.reason)
    };
  }

  // Issue #746 — segregation-of-duties conflict enforcement, additive to
  // the ordinary ABAC decision above (deny-overrides-allow: this can only
  // turn an already-`allowed` high-risk decision into a deny, never the
  // reverse). See `high-risk-sod-guard.ts`'s own header — it reasons about
  // permissions held via BOTH the business-scope-assignment path AND
  // ordinary RBAC role grants (security-auditor finding on PR #776
  // corrected an earlier version that only checked the former).
  if (isHighRiskAction(guard.action)) {
    const sodCheck = await checkHighRiskSoDConflicts(
      tx,
      tenantId,
      context,
      guard,
      now,
      options?.hierarchyPort
    );

    if (sodCheck.blocked) {
      return {
        allowed: false,
        denied: fail(403, "SOD_CONFLICT", sodCheck.reason)
      };
    }
  }

  return { allowed: true, context, grantedPermissionKeys };
}
