import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  CreateSocialPublishTemplateInput,
  UpdateSocialPublishTemplateInput
} from "../domain/social-publish-template-validation";

/**
 * CRUD for `awcms_mini_social_publish_templates` (Issue #643). Gated by the
 * `rules.read`/`rules.configure` permissions (no separate `templates.*`
 * permission — deliberately reusing the issue's own suggested permission
 * list rather than inventing new ones, see migration 050's header).
 */
export type SocialPublishTemplateView = {
  id: string;
  tenantId: string;
  providerKey: string | null;
  name: string;
  captionTemplate: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type SocialPublishTemplateRow = {
  id: string;
  tenant_id: string;
  provider_key: string | null;
  name: string;
  caption_template: string;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

function toView(row: SocialPublishTemplateRow): SocialPublishTemplateView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    providerKey: row.provider_key,
    name: row.name,
    captionTemplate: row.caption_template,
    isDefault: row.is_default,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const AUDIT_MODULE_KEY = "social_publishing";
const AUDIT_RESOURCE_TYPE = "social_publish_template";

export async function createSocialPublishTemplate(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateSocialPublishTemplateInput,
  correlationId?: string
): Promise<SocialPublishTemplateView> {
  const rows = (await tx`
    INSERT INTO awcms_mini_social_publish_templates
      (tenant_id, provider_key, name, caption_template, is_default, is_active)
    VALUES (
      ${tenantId}, ${input.providerKey}, ${input.name}, ${input.captionTemplate},
      ${input.isDefault}, ${input.isActive}
    )
    RETURNING id, tenant_id, provider_key, name, caption_template, is_default,
      is_active, created_at, updated_at
  `) as SocialPublishTemplateRow[];

  const created = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.template.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: created.id,
    severity: "info",
    message: `Social publish template created: ${created.name}.`,
    correlationId
  });

  return created;
}

export async function fetchSocialPublishTemplateById(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<SocialPublishTemplateView | null> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, name, caption_template, is_default,
      is_active, created_at, updated_at
    FROM awcms_mini_social_publish_templates
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as SocialPublishTemplateRow[];

  const row = rows[0];
  return row ? toView(row) : null;
}

export async function listSocialPublishTemplates(
  tx: Bun.SQL,
  tenantId: string
): Promise<SocialPublishTemplateView[]> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, name, caption_template, is_default,
      is_active, created_at, updated_at
    FROM awcms_mini_social_publish_templates
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 500
  `) as SocialPublishTemplateRow[];

  return rows.map(toView);
}

export async function updateSocialPublishTemplate(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  input: UpdateSocialPublishTemplateInput,
  correlationId?: string
): Promise<SocialPublishTemplateView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_templates
    SET name = COALESCE(${input.name ?? null}, name),
        caption_template = COALESCE(${input.captionTemplate ?? null}, caption_template),
        is_default = COALESCE(${input.isDefault ?? null}, is_default),
        is_active = COALESCE(${input.isActive ?? null}, is_active),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id, tenant_id, provider_key, name, caption_template, is_default,
      is_active, created_at, updated_at
  `) as SocialPublishTemplateRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.template.updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `Social publish template updated: ${updated.name}.`,
    correlationId
  });

  return updated;
}

export async function softDeleteSocialPublishTemplate(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  reason: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_templates
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING name
  `) as { name: string }[];

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.template.deleted",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "warning",
    message: `Social publish template deleted: ${rows[0]!.name}.`,
    attributes: { reason },
    correlationId
  });

  return true;
}

/** `templateId` resolution used by `create-social-publish-jobs.ts` — a `null`/soft-deleted/inactive template id falls back to `null` (caller then uses the article's raw excerpt as the caption, no template). */
export async function fetchActiveCaptionTemplate(
  tx: Bun.SQL,
  tenantId: string,
  templateId: string | null
): Promise<string | null> {
  if (!templateId) return null;

  const rows = (await tx`
    SELECT caption_template FROM awcms_mini_social_publish_templates
    WHERE tenant_id = ${tenantId} AND id = ${templateId}
      AND deleted_at IS NULL AND is_active = true
  `) as { caption_template: string }[];

  return rows[0]?.caption_template ?? null;
}
