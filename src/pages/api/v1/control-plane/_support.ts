/**
 * Composition-root wiring for the control-plane SUPPORT-ACCESS routes (Issue
 * #879, ADR-0022 §5/§6 — FIX MEDIUM-5). A leading-underscore, NON-route module.
 *
 * A support/platform operator authenticates in their OWN (platform singleton)
 * tenant; the `identity_access.support_access.*` permission is evaluated there
 * (never BYPASSRLS). The GRANT itself is written/read in the TARGET tenant's
 * per-tenant RLS context, so it is scoped to exactly that tenant and can never be
 * substituted for another. `approve`/`revoke` are high-risk actions, so the SoD
 * chokepoint (rule `identity_access.support_request_vs_approve`) and step-up run
 * at those steps.
 */
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { fail } from "../../../../modules/_shared/api-response";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import type { AccessAction } from "../../../../modules/identity-access/domain/access-control";
import { hashSessionToken } from "../../../../lib/auth/session-token";

const MODULE_KEY = "identity_access";
const ACTIVITY = "support_access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export type SupportOperatorAuth = {
  actorTenantUserId: string;
  operatorIdentityId: string;
};

async function readPlatformTenantId(tx: Bun.SQL): Promise<string | null> {
  const rows = (await tx`
    SELECT tenant_id FROM awcms_mini_setup_state WHERE id = true
  `) as { tenant_id: string | null }[];
  return rows[0]?.tenant_id ?? null;
}

/**
 * Authorize a support-access lifecycle action. The caller must be the platform
 * operator (setup singleton) tenant. `action` drives permission + (for
 * approve/revoke) the high-risk SoD/step-up chokepoint.
 */
export async function authorizeSupportOperator(
  request: Request,
  cookies: import("astro").AstroCookies,
  action: AccessAction
): Promise<SupportOperatorAuth | Response> {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const result = await withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      { moduleKey: MODULE_KEY, activityCode: ACTIVITY, action }
    );
    if (!auth.allowed) return auth.denied;
    const platformTenantId = await readPlatformTenantId(tx);
    if (!platformTenantId || platformTenantId !== tenantId) {
      return fail(
        403,
        "ACCESS_DENIED",
        "Support-access administration is restricted to the platform operator tenant."
      );
    }
    return {
      actorTenantUserId: auth.context.tenantUserId,
      operatorIdentityId: auth.context.identityId
    };
  });
  return result as SupportOperatorAuth | Response;
}

export function withTargetTenant<T>(
  targetTenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, fn);
}

export function successBody(data: unknown): {
  success: true;
  data: unknown;
  meta: Record<string, never>;
} {
  return { success: true, data, meta: {} };
}
