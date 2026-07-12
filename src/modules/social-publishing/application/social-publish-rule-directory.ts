import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  CreateSocialPublishRuleInput,
  SocialPublishTriggerEvent,
  UpdateSocialPublishRuleInput
} from "../domain/social-publish-rule-validation";

export type SocialPublishRuleView = {
  id: string;
  tenantId: string;
  socialAccountId: string;
  triggerEvent: SocialPublishTriggerEvent;
  requiresApproval: boolean;
  isEnabled: boolean;
  templateId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type SocialPublishRuleRow = {
  id: string;
  tenant_id: string;
  social_account_id: string;
  trigger_event: SocialPublishTriggerEvent;
  requires_approval: boolean;
  is_enabled: boolean;
  template_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toView(row: SocialPublishRuleRow): SocialPublishRuleView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    socialAccountId: row.social_account_id,
    triggerEvent: row.trigger_event,
    requiresApproval: row.requires_approval,
    isEnabled: row.is_enabled,
    templateId: row.template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

const AUDIT_MODULE_KEY = "social_publishing";
const AUDIT_RESOURCE_TYPE = "social_publish_rule";

export async function createSocialPublishRule(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateSocialPublishRuleInput,
  correlationId?: string
): Promise<SocialPublishRuleView> {
  const rows = (await tx`
    INSERT INTO awcms_mini_social_publish_rules
      (tenant_id, social_account_id, trigger_event, requires_approval, is_enabled, template_id)
    VALUES (
      ${tenantId}, ${input.socialAccountId}, ${input.triggerEvent},
      ${input.requiresApproval}, ${input.isEnabled}, ${input.templateId}
    )
    RETURNING id, tenant_id, social_account_id, trigger_event, requires_approval,
      is_enabled, template_id, created_at, updated_at, deleted_at
  `) as SocialPublishRuleRow[];

  const created = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.rule.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: created.id,
    severity: "info",
    message: `Social publish rule created for trigger "${created.triggerEvent}".`,
    attributes: {
      socialAccountId: created.socialAccountId,
      triggerEvent: created.triggerEvent
    },
    correlationId
  });

  return created;
}

export async function fetchSocialPublishRuleById(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<SocialPublishRuleView | null> {
  const rows = (await tx`
    SELECT id, tenant_id, social_account_id, trigger_event, requires_approval,
      is_enabled, template_id, created_at, updated_at, deleted_at
    FROM awcms_mini_social_publish_rules
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as SocialPublishRuleRow[];

  const row = rows[0];
  return row ? toView(row) : null;
}

export async function listSocialPublishRules(
  tx: Bun.SQL,
  tenantId: string
): Promise<SocialPublishRuleView[]> {
  const rows = (await tx`
    SELECT id, tenant_id, social_account_id, trigger_event, requires_approval,
      is_enabled, template_id, created_at, updated_at, deleted_at
    FROM awcms_mini_social_publish_rules
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 500
  `) as SocialPublishRuleRow[];

  return rows.map(toView);
}

/**
 * Enabled rules matching a trigger event, joined with their account — used
 * by `create-social-publish-jobs.ts` to decide which (rule, account) pairs
 * get a job. Only `connected` + `auto_publish_enabled` accounts are
 * returned (a rule for a disconnected/paused account never produces a
 * job).
 *
 * Deliberately does NOT select `token_reference` — job creation never
 * needs a real credential (it only snapshots content + enqueues an outbox
 * row, no provider call happens here per ADR-0006). Round 1
 * security-auditor review (PR #731) found this row type used to carry
 * `tokenReference` anyway even though nothing downstream ever read it —
 * dead data with no consumer, removed rather than left as an unused extra
 * `token_reference` read path outside the one sanctioned
 * `fetchSocialAccountTokenReferenceForDispatch` (`social-account-directory.ts`).
 */
export type EligibleSocialPublishRuleRow = {
  ruleId: string;
  socialAccountId: string;
  providerKey: string;
  requiresApproval: boolean;
  templateId: string | null;
};

export async function listEligibleSocialPublishRulesForTrigger(
  tx: Bun.SQL,
  tenantId: string,
  triggerEvent: SocialPublishTriggerEvent
): Promise<EligibleSocialPublishRuleRow[]> {
  const rows = (await tx`
    SELECT r.id AS rule_id, r.social_account_id, a.provider_key,
      r.requires_approval, r.template_id
    FROM awcms_mini_social_publish_rules r
    JOIN awcms_mini_social_accounts a
      ON a.id = r.social_account_id AND a.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId} AND r.deleted_at IS NULL AND r.is_enabled = true
      AND r.trigger_event = ${triggerEvent}
      AND a.connection_status = 'connected' AND a.auto_publish_enabled = true
  `) as {
    rule_id: string;
    social_account_id: string;
    provider_key: string;
    requires_approval: boolean;
    template_id: string | null;
  }[];

  return rows.map((row) => ({
    ruleId: row.rule_id,
    socialAccountId: row.social_account_id,
    providerKey: row.provider_key,
    requiresApproval: row.requires_approval,
    templateId: row.template_id
  }));
}

export async function updateSocialPublishRule(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  input: UpdateSocialPublishRuleInput,
  correlationId?: string
): Promise<SocialPublishRuleView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_rules
    SET requires_approval = COALESCE(${input.requiresApproval ?? null}, requires_approval),
        is_enabled = COALESCE(${input.isEnabled ?? null}, is_enabled),
        template_id = CASE WHEN ${input.templateId === undefined} THEN template_id ELSE ${input.templateId ?? null} END,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id, tenant_id, social_account_id, trigger_event, requires_approval,
      is_enabled, template_id, created_at, updated_at, deleted_at
  `) as SocialPublishRuleRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.rule.updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `Social publish rule updated for trigger "${updated.triggerEvent}".`,
    correlationId
  });

  return updated;
}

export async function softDeleteSocialPublishRule(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  reason: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_rules
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING trigger_event
  `) as { trigger_event: SocialPublishTriggerEvent }[];

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.rule.deleted",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "warning",
    message: `Social publish rule deleted (trigger "${rows[0]!.trigger_event}").`,
    attributes: { reason },
    correlationId
  });

  return true;
}
