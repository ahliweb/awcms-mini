import type { AstroCookies } from "astro";

import { getDatabaseClient } from "../database/client";
import { withTenant } from "../database/tenant-context";
import { hashSessionToken } from "./session-token";
import { resolveActiveSession } from "../../modules/identity-access/application/session-lookup";

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
  /**
   * Tenant's `default_locale` (Issue #433 — i18n), fetched here so
   * `src/middleware.ts` can resolve the final locale (cookie -> tenant
   * default -> `en`) *before* any `/admin/*` page or `AdminLayout.astro`
   * renders — resolving it later, inside the layout, is too late: a page's
   * own frontmatter (and its own `t()` calls) runs before the layout
   * component it's nested in, so only middleware can make this available in
   * time. `null` if the tenant row is somehow missing.
   */
  tenantDefaultLocale: string | null;
};

type SsrSessionResolutionRow = {
  tenant_user_id: string;
  default_locale: string | null;
  role_code: string | null;
  module_key: string | null;
  activity_code: string | null;
  action: string | null;
  module_enabled: boolean | null;
};

/**
 * Resolve the authenticated tenant/session context for an SSR page render
 * from the two auth cookies. Mirrors the bearer-token guard chain
 * (`resolveTenantContext` + `fetchGrantedPermissionKeys` from
 * `src/modules/identity-access/application/auth-context.ts`) with ONE
 * deliberate, security-relevant difference and one performance one:
 *
 * **Module-enabled gate (Issue #841).** `context.permissions` here EXCLUDES
 * every permission key whose owning module is disabled for this tenant
 * (`awcms_mini_tenant_modules.enabled = false`). The bearer-token route path
 * already refuses `403 MODULE_DISABLED` in `authorizeInTransaction`
 * (`access-guard.ts`) *before* it evaluates RBAC, but the 54 admin SSR pages
 * gate purely on `context.permissions.has(permissionKey(...))`. Filtering the
 * disabled-module keys out of the SSR permission set here — in the single
 * helper every page shares — makes "disable a module" actually stop those
 * pages from rendering the module's tenant data, at parity with the route,
 * WITHOUT touching all 54 call sites (and without touching the shared
 * `fetchGrantedPermissionKeys`, which several API paths rely on to NOT filter
 * disabled modules — see `descriptor-authorization.ts`). Roles are NOT
 * affected by the gate: a subject keeps its role identity even for a disabled
 * module; only the module's *capabilities* disappear from the SSR set.
 *
 * **One combined query (Issue #835 §7).** Session lookup stays its own query
 * (it yields the `identity_id` the rest keys off), then a single query
 * resolves the tenant-user row, tenant `default_locale`, granted roles, and
 * module-gated permission keys together — 2 DB round-trips instead of the
 * previous 5 serial ones. `LEFT JOIN`s keep a zero-permission role and a
 * tenant with a missing `tenants` row behaving exactly as the old separate
 * queries did.
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

    return await withTenant(sql, tenantId, (tx) =>
      loadSsrSessionData(tx, tenantId, tokenHash, now)
    );
  } catch {
    return null;
  }
}

/**
 * The in-transaction core of `resolveSsrContext`, split out so tests can
 * drive it with a real tenant-scoped `tx` (comparing against the route path's
 * `resolveTenantContext`/`fetchGrantedPermissionKeys` — Issue #841 parity)
 * and count its DB round-trips (Issue #835 §7: exactly two — the session
 * lookup and the one combined query below). `tx` must already be tenant-scoped
 * (`withTenant`), exactly like every other `application`-layer directory here.
 */
export async function loadSsrSessionData(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<SsrContext | null> {
  const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

  if (!session) {
    return null;
  }

  // One query for tenant-user + locale + roles + module-gated permissions.
  // Faithful to the old three separate queries:
  //  - roles: `INNER JOIN roles ... deleted_at IS NULL` becomes a LEFT JOIN
  //    with the same predicate so a soft-deleted role contributes no
  //    role_code (filtered as NULL below), matching `resolveTenantContext`.
  //  - permissions: joined off `r.id` (the deleted-filtered role), so a
  //    soft-deleted role contributes no permissions either, matching
  //    `fetchGrantedPermissionKeys`'s `JOIN roles ... deleted_at IS NULL`.
  //  - module gate (#841): `tm.enabled = false` drops the permission key; a
  //    missing `tenant_modules` row (NULL) or `true` keeps it, exactly
  //    `resolveModuleEnabled`'s "missing row = enabled" default.
  const rows = (await tx`
    SELECT
      tu.id AS tenant_user_id,
      t.default_locale AS default_locale,
      r.role_code AS role_code,
      p.module_key AS module_key,
      p.activity_code AS activity_code,
      p.action AS action,
      tm.enabled AS module_enabled
    FROM awcms_mini_tenant_users tu
    LEFT JOIN awcms_mini_tenants t ON t.id = tu.tenant_id
    LEFT JOIN awcms_mini_access_assignments aa
      ON aa.tenant_id = tu.tenant_id AND aa.tenant_user_id = tu.id
    LEFT JOIN awcms_mini_roles r
      ON r.id = aa.role_id AND r.deleted_at IS NULL
    LEFT JOIN awcms_mini_role_permissions rp
      ON rp.role_id = r.id AND rp.tenant_id = tu.tenant_id
    LEFT JOIN awcms_mini_permissions p ON p.id = rp.permission_id
    LEFT JOIN awcms_mini_tenant_modules tm
      ON tm.tenant_id = tu.tenant_id AND tm.module_key = p.module_key
    WHERE tu.tenant_id = ${tenantId}
      AND tu.identity_id = ${session.identity_id}
  `) as SsrSessionResolutionRow[];

  if (rows.length === 0) {
    return null;
  }

  const roles = new Set<string>();
  const permissions = new Set<string>();

  for (const row of rows) {
    if (row.role_code !== null) {
      roles.add(row.role_code);
    }

    if (
      row.module_key !== null &&
      row.activity_code !== null &&
      row.action !== null &&
      row.module_enabled !== false
    ) {
      permissions.add(`${row.module_key}.${row.activity_code}.${row.action}`);
    }
  }

  return {
    tenantId,
    tenantUserId: rows[0]!.tenant_user_id,
    identityId: session.identity_id,
    roles: [...roles],
    permissions,
    tenantDefaultLocale: rows[0]!.default_locale ?? null
  };
}
