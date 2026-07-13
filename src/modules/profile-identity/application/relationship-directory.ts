import { recordAuditEvent } from "../../logging/application/audit-log";
import type { CreateRelationshipInput } from "../domain/relationship";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile_relationship";

export type RelationshipView = {
  id: string;
  fromProfileId: string;
  toProfileId: string;
  relationshipType: string;
  isAuthorizedRepresentative: boolean;
  representationScope: string | null;
  status: string;
  validFrom: string;
  validUntil: string | null;
  createdAt: string;
};

type RelationshipRow = {
  id: string;
  from_profile_id: string;
  to_profile_id: string;
  relationship_type: string;
  is_authorized_representative: boolean;
  representation_scope: string | null;
  status: string;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
};

function toView(row: RelationshipRow): RelationshipView {
  return {
    id: row.id,
    fromProfileId: row.from_profile_id,
    toProfileId: row.to_profile_id,
    relationshipType: row.relationship_type,
    isAuthorizedRepresentative: row.is_authorized_representative,
    representationScope: row.representation_scope,
    status: row.status,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until ? row.valid_until.toISOString() : null,
    createdAt: row.created_at.toISOString()
  };
}

export class RelationshipTargetNotFoundError extends Error {
  constructor() {
    super("toProfileId does not reference an active profile in this tenant.");
    this.name = "RelationshipTargetNotFoundError";
  }
}

export async function createRelationship(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  fromProfileId: string,
  input: CreateRelationshipInput,
  correlationId?: string
): Promise<RelationshipView> {
  const targetRows = await tx`
    SELECT id FROM awcms_mini_profiles
    WHERE tenant_id = ${tenantId} AND id = ${input.toProfileId} AND deleted_at IS NULL
  `;

  if (targetRows.length === 0) {
    throw new RelationshipTargetNotFoundError();
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_profile_relationships
      (tenant_id, from_profile_id, to_profile_id, relationship_type,
       is_authorized_representative, representation_scope, valid_from, valid_until, created_by)
    VALUES (
      ${tenantId}, ${fromProfileId}, ${input.toProfileId}, ${input.relationshipType},
      ${input.isAuthorizedRepresentative}, ${input.representationScope}, ${input.validFrom},
      ${input.validUntil}, ${actorTenantUserId}
    )
    RETURNING id, from_profile_id, to_profile_id, relationship_type,
      is_authorized_representative, representation_scope, status, valid_from, valid_until, created_at
  `) as RelationshipRow[];

  const view = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "relationship_added",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "info",
    message: `Relationship added: ${view.relationshipType}.`,
    attributes: {
      relationshipType: view.relationshipType,
      isAuthorizedRepresentative: view.isAuthorizedRepresentative
    },
    correlationId
  });

  return view;
}

/** Both directions — a profile's relationships are meaningful whether it's the `from` or `to` side. */
export async function listRelationshipsForProfile(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<RelationshipView[]> {
  const rows = (await tx`
    SELECT id, from_profile_id, to_profile_id, relationship_type,
      is_authorized_representative, representation_scope, status, valid_from, valid_until, created_at
    FROM awcms_mini_profile_relationships
    WHERE tenant_id = ${tenantId}
      AND (from_profile_id = ${profileId} OR to_profile_id = ${profileId})
    ORDER BY created_at DESC
  `) as RelationshipRow[];

  return rows.map(toView);
}

export async function endRelationship(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  relationshipId: string,
  reason: string | null,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_mini_profile_relationships
    SET status = 'ended', ended_by = ${actorTenantUserId}, ended_at = now(),
        end_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND (from_profile_id = ${profileId} OR to_profile_id = ${profileId})
      AND id = ${relationshipId} AND status = 'active'
    RETURNING id
  `;

  if (rows.length === 0) {
    return false;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "relationship_ended",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: relationshipId,
    severity: "info",
    message: "Relationship ended.",
    attributes: reason ? { reason } : {},
    correlationId
  });

  return true;
}
