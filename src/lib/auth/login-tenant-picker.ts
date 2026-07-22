import { getDatabaseClient } from "../database/client";

/**
 * Login tenant picker (opt-in). When `AUTH_LOGIN_TENANT_PICKER=true`,
 * `login.astro` renders the tenant field as a `<select>` of active tenant
 * names instead of the default manual tenant-id text input.
 *
 * Off by default on purpose: rendering the picker lists every active
 * tenant's name + id on the pre-auth `/login` page, i.e. tenant
 * enumeration. That's acceptable for a single/few-tenant website
 * deployment (the base repo's typical shape — see the tenant-id field's
 * own note in `login.astro`), but an information disclosure for a
 * multi-tenant one, so the operator has to opt in per deployment.
 */
export function isLoginTenantPickerEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.AUTH_LOGIN_TENANT_PICKER === "true";
}

export type LoginTenantOption = {
  id: string;
  name: string;
};

/**
 * Active tenants for the login picker, ordered by display name. Queries
 * `awcms_mini_tenants` directly (no `withTenant`): that table is
 * intentionally RLS-free — it IS the tenant root, so there is no tenant
 * context to scope by, and this list is only ever built when the operator
 * has opted into exposing it via `isLoginTenantPickerEnabled`.
 */
export async function listActiveTenantsForLogin(): Promise<
  LoginTenantOption[]
> {
  const sql = getDatabaseClient();
  const rows = await sql`
    SELECT id, tenant_name
    FROM awcms_mini_tenants
    WHERE status = 'active'
    ORDER BY tenant_name ASC
  `;

  return (rows as Array<{ id: string; tenant_name: string }>).map((row) => ({
    id: row.id,
    name: row.tenant_name
  }));
}
