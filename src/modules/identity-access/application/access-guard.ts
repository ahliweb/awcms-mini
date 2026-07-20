import type { AstroCookies } from "astro";

import { fail } from "../../_shared/api-response";
import type { BusinessScopeHierarchyPort } from "../../_shared/ports/business-scope-hierarchy-port";
import {
  isWriteAction,
  lifecycleAccessDecision
} from "../../_shared/tenant-lifecycle-policy";
import { readTenantRestrictionSnapshot } from "../../_shared/tenant-lifecycle-restriction-read";
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
import { loadActivePolicies } from "./policy-cache";
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
 * optional (this file is imported by a large and growing number of route
 * files, only one of which, `revoke.ts`, has any hierarchy port to offer
 * today). Every existing
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

  // Issue #179 — load the tenant's active, compiled ABAC policies (tenant-keyed
  // cache, deterministically invalidated on any policy mutation) and evaluate
  // them at this single chokepoint, AFTER session/tenant/module-enabled/RBAC
  // resolution. An empty policy set (the default for every tenant that has
  // authored none) makes ABAC a no-op — behavior is unchanged. `ipTrusted`
  // defaults to false (fail-closed) until a deployment wires a trusted-network
  // resolver; `env.now` is the request timestamp already threaded through here.
  const policies = await loadActivePolicies(tx, tenantId);
  const decision = evaluateAccess(
    context,
    guard,
    grantedPermissionKeys,
    undefined,
    {
      policies,
      env: { now, ipTrusted: false }
    }
  );

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

  // Issue #873 (tenant_lifecycle, ADR-0022 §6 High-2) — server-derived,
  // fail-closed LIFECYCLE restriction, enforced here at the SINGLE API + SSR
  // chokepoint (never per-route — memory `ssr-admin-pages-skip-module-enabled`)
  // via the NEUTRAL-GROUND reader/policy in `_shared` (this base module never
  // imports the control-plane module — module-boundary). A tenant NOT governed
  // by lifecycle (no record — every LAN/offline tenant that never opted in)
  // resolves `governing: false` -> ALLOW_ALL, so behavior is UNCHANGED for
  // every existing tenant/test. A suspended/canceled/blocked/restoring/
  // provisioning tenant (adminAccessAllowed=false) is denied all access; a
  // past_due tenant (writesAllowed=false) is denied WRITES only. The
  // `tenant_lifecycle` module's OWN endpoints are exempt so an operator/owner
  // can still read status, restore, and run owner recovery/export while the
  // tenant is restricted (those endpoints self-govern via their own separately-
  // authorized permissions). Public host routing + background workers enforce
  // the SAME suspension through the projected `awcms_mini_tenants.status`
  // (`tenant_lifecycle` sets it in the same commit) — the four-surface parity.
  if (guard.moduleKey !== "tenant_lifecycle") {
    const restriction = await readTenantRestrictionSnapshot(tx, tenantId, now);
    if (restriction.governing) {
      const lifecycle = lifecycleAccessDecision(
        restriction.profile,
        isWriteAction(guard.action)
      );
      if (!lifecycle.allowed) {
        const reason =
          lifecycle.reason === "suspended"
            ? `Tenant lifecycle state "${restriction.state}" suspends access.`
            : `Tenant lifecycle state "${restriction.state}" is read-only.`;
        await recordDecisionLog(tx, tenantId, context.tenantUserId, guard, {
          allowed: false,
          reason,
          matchedPolicy:
            lifecycle.reason === "suspended"
              ? "lifecycle_suspended"
              : "lifecycle_read_only"
        });
        return {
          allowed: false,
          denied: fail(
            403,
            lifecycle.reason === "suspended"
              ? "TENANT_SUSPENDED"
              : "TENANT_READ_ONLY",
            reason
          )
        };
      }
    }
  }

  return { allowed: true, context, grantedPermissionKeys };
}
