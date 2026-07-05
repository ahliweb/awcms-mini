import type { AstroCookies } from "astro";

import { getDatabaseClient } from "../database/client";
import { withTenant } from "../database/tenant-context";
import { hashSessionToken } from "./session-token";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../modules/identity-access/application/auth-context";

/**
 * Cookie names shared by the SSR admin shell (Issue 8.1) and the additive
 * cookie-set/cookie-clear logic in `POST /auth/login` and `POST /auth/logout`
 * (`src/pages/api/v1/auth/login.ts`, `logout.ts`). Both cookies are httpOnly
 * + SameSite=Lax so the raw session token is never readable from
 * client-side JavaScript (doc 15 §Autentikasi dan sesi).
 */
export const SESSION_COOKIE_NAME = "awcms_mini_session";
export const TENANT_COOKIE_NAME = "awcms_mini_tenant_id";

export type SsrContext = {
  tenantId: string;
  tenantUserId: string;
  identityId: string;
  roles: string[];
  permissions: Set<string>;
};

/**
 * Resolve the authenticated tenant/session context for an SSR page render
 * from the two auth cookies, mirroring exactly what `POST /access/evaluate`
 * does for bearer-token requests (`resolveTenantContext` +
 * `fetchGrantedPermissionKeys` from
 * `src/modules/identity-access/application/auth-context.ts`).
 *
 * Returns `null` — never throws — whenever the cookies are missing, the
 * session is invalid/expired/revoked, the tenant-user membership is gone,
 * or the tenant id cookie is malformed. Callers (e.g. `AdminLayout.astro`)
 * treat `null` as "redirect to /login"; we never leak DB/validation errors
 * to the caller here (doc 10 §Guardrail keamanan — no stack traces).
 */
export async function resolveSsrContext(
  cookies: AstroCookies,
  now: Date
): Promise<SsrContext | null> {
  const tenantId = cookies.get(TENANT_COOKIE_NAME)?.value ?? null;
  const sessionToken = cookies.get(SESSION_COOKIE_NAME)?.value ?? null;

  if (!tenantId || !sessionToken) {
    return null;
  }

  try {
    const sql = getDatabaseClient();
    const tokenHash = hashSessionToken(sessionToken);

    return await withTenant(sql, tenantId, async (tx) => {
      const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

      if (!context) {
        return null;
      }

      const permissions = await fetchGrantedPermissionKeys(
        tx,
        tenantId,
        context.tenantUserId
      );

      return {
        tenantId: context.tenantId,
        tenantUserId: context.tenantUserId,
        identityId: context.identityId,
        roles: context.roles,
        permissions
      };
    });
  } catch {
    return null;
  }
}
