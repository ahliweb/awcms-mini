/**
 * Read-side query shared by `GET /api/v1/settings` and the future
 * `/admin/settings` SSR page — same pattern as
 * `identity-access/application/user-directory.ts` being shared between the
 * Access & Users endpoints and `admin/access-users.astro`.
 *
 * Joins two tables deliberately: `awcms_mini_tenants` (tenant_name,
 * legal_name, default_locale, default_theme — this table is RLS-free, see
 * scripts/security-readiness.ts RLS_FREE_TABLES, so the caller MUST scope by
 * `tenantId` itself) and `awcms_mini_tenant_settings` (timezone,
 * feature_flags — RLS tenant-scoped, created 1:1 by the Setup Wizard).
 */
export type TenantSettingsView = {
  tenantId: string;
  tenantName: string;
  legalName: string | null;
  defaultLocale: string;
  defaultTheme: string;
  timezone: string;
  featureFlags: Record<string, unknown>;
};

type TenantRow = {
  id: string;
  tenant_name: string;
  legal_name: string | null;
  default_locale: string;
  default_theme: string;
};

type TenantSettingsRow = {
  timezone: string;
  feature_flags: Record<string, unknown>;
};

export async function fetchTenantSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<TenantSettingsView | null> {
  const tenantRows = (await tx`
    SELECT id, tenant_name, legal_name, default_locale, default_theme
    FROM awcms_mini_tenants
    WHERE id = ${tenantId}
  `) as TenantRow[];
  const tenant = tenantRows[0];

  if (!tenant) {
    return null;
  }

  const settingsRows = (await tx`
    SELECT timezone, feature_flags
    FROM awcms_mini_tenant_settings
    WHERE tenant_id = ${tenantId}
  `) as TenantSettingsRow[];
  const settings = settingsRows[0];

  return {
    tenantId: tenant.id,
    tenantName: tenant.tenant_name,
    legalName: tenant.legal_name,
    defaultLocale: tenant.default_locale,
    defaultTheme: tenant.default_theme,
    timezone: settings?.timezone ?? "Asia/Jakarta",
    featureFlags: settings?.feature_flags ?? {}
  };
}
