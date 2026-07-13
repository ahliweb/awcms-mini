import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordCounter } from "../../../lib/observability/metrics-port";
import type {
  CreatePartyInput,
  UpdatePartyInput
} from "../domain/party-validation";
import type { PartyRecordForProjection } from "../domain/projection";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile";

type PartyRow = {
  id: string;
  tenant_id: string;
  profile_type: string;
  display_name: string;
  legal_name: string | null;
  status: string;
  verification_status: string;
  risk_level: string;
  merged_into_profile_id: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  delete_reason: string | null;
  restored_at: Date | null;
  restored_by: string | null;
};

function toRecord(row: PartyRow): PartyRecordForProjection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    profileType: row.profile_type,
    displayName: row.display_name,
    legalName: row.legal_name,
    status: row.status,
    verificationStatus: row.verification_status,
    riskLevel: row.risk_level,
    mergedIntoProfileId: row.merged_into_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deleteReason: row.delete_reason,
    restoredAt: row.restored_at,
    restoredBy: row.restored_by
  };
}

/**
 * Query column list repeated literally at each call site — same
 * convention every other directory module in this repo uses (see
 * `social-account-directory.ts`'s own header comment), not factored into
 * a shared fragment.
 */
export async function createParty(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreatePartyInput,
  correlationId?: string
): Promise<PartyRecordForProjection> {
  const rows = (await tx`
    INSERT INTO awcms_mini_profiles
      (tenant_id, profile_type, display_name, legal_name, risk_level, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.profileType}, ${input.displayName}, ${input.legalName},
      ${input.riskLevel}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, profile_type, display_name, legal_name, status,
      verification_status, risk_level, merged_into_profile_id, created_at, updated_at,
      created_by, updated_by, deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as PartyRow[];

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "profile_created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    severity: "info",
    message: `Party created: ${record.profileType}.`,
    attributes: { profileType: record.profileType },
    correlationId
  });

  recordCounter("profile_identity_party_lifecycle_total", { action: "create" });

  return record;
}

export async function fetchPartyById(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<PartyRecordForProjection | null> {
  const rows = (await tx`
    SELECT id, tenant_id, profile_type, display_name, legal_name, status,
      verification_status, risk_level, merged_into_profile_id, created_at, updated_at,
      created_by, updated_by, deleted_at, deleted_by, delete_reason, restored_at, restored_by
    FROM awcms_mini_profiles
    WHERE tenant_id = ${tenantId} AND id = ${profileId}
      AND (deleted_at IS NULL OR ${options.includeDeleted === true})
  `) as PartyRow[];

  const row = rows[0];
  return row ? toRecord(row) : null;
}

export type ListPartiesOptions = {
  profileType?: "person" | "organization";
  status?: string;
  query?: string;
  limit?: number;
  includeDeleted?: boolean;
};

export type ListPartiesResult = {
  items: PartyRecordForProjection[];
};

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** Search: simple case-insensitive substring match on `display_name`/`legal_name` (`ILIKE`) — no full-text search index in this issue, kept intentionally simple; a derived application needing large-scale search can add a dedicated index later without changing this function's contract. Optional filters use the `(${value} IS NULL OR column = ${value})` pattern already established by `domain-event-directory.ts`/`form-draft-directory.ts`/`data-lifecycle`'s directory modules — a single literal query, no dynamic SQL string composition. */
export async function listParties(
  tx: Bun.SQL,
  tenantId: string,
  options: ListPartiesOptions = {}
): Promise<ListPartiesResult> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT
  );
  const likePattern = options.query ? `%${options.query.trim()}%` : null;
  const profileType = options.profileType ?? null;
  const status = options.status ?? null;

  const rows = (await tx`
    SELECT id, tenant_id, profile_type, display_name, legal_name, status,
      verification_status, risk_level, merged_into_profile_id, created_at, updated_at,
      created_by, updated_by, deleted_at, deleted_by, delete_reason, restored_at, restored_by
    FROM awcms_mini_profiles
    WHERE tenant_id = ${tenantId}
      AND (deleted_at IS NULL OR ${options.includeDeleted === true})
      AND (${profileType}::text IS NULL OR profile_type = ${profileType})
      AND (${status}::text IS NULL OR status = ${status})
      AND (
        ${likePattern}::text IS NULL
        OR display_name ILIKE ${likePattern}
        OR legal_name ILIKE ${likePattern}
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `) as PartyRow[];

  return { items: rows.map(toRecord) };
}

export async function updateParty(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  input: UpdatePartyInput,
  correlationId?: string
): Promise<PartyRecordForProjection | null> {
  const existing = await fetchPartyById(tx, tenantId, profileId);

  if (!existing) {
    return null;
  }

  const rows = (await tx`
    UPDATE awcms_mini_profiles
    SET
      display_name = ${input.displayName ?? existing.displayName},
      legal_name = ${input.legalName !== undefined ? input.legalName : existing.legalName},
      risk_level = ${input.riskLevel ?? existing.riskLevel},
      verification_status = ${input.verificationStatus ?? existing.verificationStatus},
      status = ${input.status ?? existing.status},
      updated_by = ${actorTenantUserId},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${profileId} AND deleted_at IS NULL
    RETURNING id, tenant_id, profile_type, display_name, legal_name, status,
      verification_status, risk_level, merged_into_profile_id, created_at, updated_at,
      created_by, updated_by, deleted_at, deleted_by, delete_reason, restored_at, restored_by
  `) as PartyRow[];

  if (rows.length === 0) {
    return null;
  }

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "profile_updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    severity: "info",
    message: "Party updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  recordCounter("profile_identity_party_lifecycle_total", { action: "update" });

  return record;
}
