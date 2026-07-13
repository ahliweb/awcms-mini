import { recordAuditEvent } from "../../logging/application/audit-log";
import type { CreateChannelInput } from "../domain/address-channel-validation";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile_channel";

export type ChannelView = {
  id: string;
  profileId: string;
  profileIdentifierId: string;
  channelType: string;
  isOptIn: boolean;
  isDefault: boolean;
  verifiedAt: string | null;
  validFrom: string;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChannelRow = {
  id: string;
  profile_id: string;
  profile_identifier_id: string;
  channel_type: string;
  is_opt_in: boolean;
  is_default: boolean;
  verified_at: Date | null;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    profileId: row.profile_id,
    profileIdentifierId: row.profile_identifier_id,
    channelType: row.channel_type,
    isOptIn: row.is_opt_in,
    isDefault: row.is_default,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until ? row.valid_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class ChannelIdentifierNotFoundError extends Error {
  constructor() {
    super(
      "profileIdentifierId does not reference an active identifier on this profile."
    );
    this.name = "ChannelIdentifierNotFoundError";
  }
}

export async function createChannel(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  input: CreateChannelInput,
  correlationId?: string
): Promise<ChannelView> {
  const identifierRows = await tx`
    SELECT id FROM awcms_mini_profile_identifiers
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId}
      AND id = ${input.profileIdentifierId} AND deleted_at IS NULL
  `;

  if (identifierRows.length === 0) {
    throw new ChannelIdentifierNotFoundError();
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_profile_channels
      (tenant_id, profile_id, profile_identifier_id, channel_type, is_opt_in, is_default,
       valid_from, valid_until)
    VALUES (
      ${tenantId}, ${profileId}, ${input.profileIdentifierId}, ${input.channelType},
      ${input.isOptIn}, ${input.isDefault}, ${input.validFrom}, ${input.validUntil}
    )
    RETURNING id, profile_id, profile_identifier_id, channel_type, is_opt_in, is_default,
      verified_at, valid_from, valid_until, created_at, updated_at
  `) as ChannelRow[];

  const view = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "channel_added",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "info",
    message: "Communication channel added.",
    attributes: { channelType: view.channelType },
    correlationId
  });

  return view;
}

export async function listChannels(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<ChannelView[]> {
  const rows = (await tx`
    SELECT id, profile_id, profile_identifier_id, channel_type, is_opt_in, is_default,
      verified_at, valid_from, valid_until, created_at, updated_at
    FROM awcms_mini_profile_channels
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `) as ChannelRow[];

  return rows.map(toView);
}

export async function softDeleteChannel(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  channelId: string,
  reason: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_mini_profile_channels
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason}
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND id = ${channelId}
      AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) {
    return false;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "channel_removed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: channelId,
    severity: "info",
    message: "Communication channel soft-deleted.",
    attributes: { reason },
    correlationId
  });

  return true;
}
