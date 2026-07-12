import { recordAuditEvent } from "../../logging/application/audit-log";

/**
 * Per-tenant "auto-posting enabled" master switch
 * (`awcms_mini_social_publishing_settings`, migration 050) — the
 * TENANT half of the issue's "Auto-posting can be disabled globally and
 * per tenant" requirement (the GLOBAL half is
 * `social-publishing-config.ts`'s env-only deployment gate). Unlike Issue
 * #636's tenant-state table, this one is an ordinary tenant preference — a
 * tenant Owner/Admin is SUPPOSED to be able to flip this, gated by the
 * real `rules.configure` permission via this module's own settings
 * endpoint, not a generic `module_settings` PATCH surface.
 */
export type SocialPublishingSettingsView = {
  tenantId: string;
  autoPublishingEnabled: boolean;
  updatedAt: Date;
};

type SocialPublishingSettingsRow = {
  tenant_id: string;
  auto_publishing_enabled: boolean;
  updated_at: Date;
};

function toView(
  row: SocialPublishingSettingsRow
): SocialPublishingSettingsView {
  return {
    tenantId: row.tenant_id,
    autoPublishingEnabled: row.auto_publishing_enabled,
    updatedAt: row.updated_at
  };
}

/** Defaults to `{autoPublishingEnabled: true}` when no row exists yet — a tenant that never touched this setting behaves as if auto-posting is allowed (subject to every OTHER gate: deployment env, per-account/per-rule enablement, approval). */
export async function fetchSocialPublishingSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<SocialPublishingSettingsView> {
  const rows = (await tx`
    SELECT tenant_id, auto_publishing_enabled, updated_at
    FROM awcms_mini_social_publishing_settings
    WHERE tenant_id = ${tenantId}
  `) as SocialPublishingSettingsRow[];

  const row = rows[0];

  return row
    ? toView(row)
    : { tenantId, autoPublishingEnabled: true, updatedAt: new Date(0) };
}

export async function updateSocialPublishingSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  autoPublishingEnabled: boolean,
  correlationId?: string
): Promise<SocialPublishingSettingsView> {
  const rows = (await tx`
    INSERT INTO awcms_mini_social_publishing_settings
      (tenant_id, auto_publishing_enabled, updated_by)
    VALUES (${tenantId}, ${autoPublishingEnabled}, ${actorTenantUserId})
    ON CONFLICT (tenant_id) DO UPDATE SET
      auto_publishing_enabled = EXCLUDED.auto_publishing_enabled,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING tenant_id, auto_publishing_enabled, updated_at
  `) as SocialPublishingSettingsRow[];

  const updated = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: "social_publishing",
    action: "social_publishing.settings.updated",
    resourceType: "social_publishing_settings",
    resourceId: tenantId,
    severity: "info",
    message: `Social publishing auto-posting set to ${autoPublishingEnabled} for tenant.`,
    correlationId
  });

  return updated;
}
