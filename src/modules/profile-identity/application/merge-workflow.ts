import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordCounter } from "../../../lib/observability/metrics-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  PROFILE_MERGED_EVENT_TYPE,
  PROFILE_MERGED_EVENT_VERSION
} from "../domain/merge-event";
import {
  assertMergeRequestIsValid,
  assertSameTenant,
  computeFieldConflicts,
  computeRequiresApproval,
  type FieldConflict,
  type PartySnapshot,
  type ReferenceImpactEntry,
  type ReferenceImpactSummary
} from "../domain/merge";
import type { CreateMergeRequestInput } from "../domain/merge";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile_merge_request";

export type MergeRequestView = {
  id: string;
  sourceProfileId: string;
  targetProfileId: string;
  status: string;
  reason: string | null;
  requiresApproval: boolean;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  executedBy: string | null;
  executedAt: string | null;
  fieldConflictSnapshot: FieldConflict[];
  referenceImpactSnapshot: ReferenceImpactSummary | Record<string, never>;
  duplicateCandidateId: string | null;
  createdAt: string;
  updatedAt: string;
};

type MergeRequestRow = {
  id: string;
  source_profile_id: string;
  target_profile_id: string;
  status: string;
  reason: string | null;
  requires_approval: boolean;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  executed_by: string | null;
  executed_at: Date | null;
  field_conflict_snapshot: unknown;
  reference_impact_snapshot: unknown;
  duplicate_candidate_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: MergeRequestRow): MergeRequestView {
  return {
    id: row.id,
    sourceProfileId: row.source_profile_id,
    targetProfileId: row.target_profile_id,
    status: row.status,
    reason: row.reason,
    requiresApproval: row.requires_approval,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    executedBy: row.executed_by,
    executedAt: row.executed_at ? row.executed_at.toISOString() : null,
    fieldConflictSnapshot: Array.isArray(row.field_conflict_snapshot)
      ? (row.field_conflict_snapshot as FieldConflict[])
      : [],
    referenceImpactSnapshot:
      (row.reference_impact_snapshot as ReferenceImpactSummary) ?? {},
    duplicateCandidateId: row.duplicate_candidate_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

type PartyRowForMerge = {
  id: string;
  tenant_id: string;
  profile_type: string;
  display_name: string;
  legal_name: string | null;
  risk_level: string;
  verification_status: string;
  deleted_at: Date | null;
  merged_into_profile_id: string | null;
};

async function fetchPartyForMerge(
  tx: Bun.SQL,
  profileId: string
): Promise<PartyRowForMerge | undefined> {
  const rows = (await tx`
    SELECT id, tenant_id, profile_type, display_name, legal_name, risk_level,
      verification_status, deleted_at, merged_into_profile_id
    FROM awcms_mini_profiles
    WHERE id = ${profileId}
    FOR UPDATE
  `) as PartyRowForMerge[];

  return rows[0];
}

function toSnapshot(row: PartyRowForMerge): PartySnapshot {
  return {
    id: row.id,
    profileType: row.profile_type,
    displayName: row.display_name,
    legalName: row.legal_name,
    riskLevel: row.risk_level,
    verificationStatus: row.verification_status
  };
}

/** Reference-impact preview: how many `awcms_mini_profile_entity_links` rows, grouped by owning module/entity type, would be repointed from `profileId` to a survivor. Read-only — safe to call for a preview without executing anything. */
export async function computeReferenceImpactSummary(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<ReferenceImpactSummary> {
  const rows = (await tx`
    SELECT module_key, entity_type, COUNT(*)::int AS count
    FROM awcms_mini_profile_entity_links
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId}
    GROUP BY module_key, entity_type
    ORDER BY module_key, entity_type
  `) as { module_key: string; entity_type: string; count: number }[];

  const byModule: ReferenceImpactEntry[] = rows.map((row) => ({
    moduleKey: row.module_key,
    entityType: row.entity_type,
    count: row.count
  }));

  return {
    totalEntityLinks: byModule.reduce((sum, entry) => sum + entry.count, 0),
    byModule
  };
}

export class MergePartyNotFoundError extends Error {
  constructor(which: "source" | "target") {
    super(
      `Merge ${which} profile not found, already soft-deleted, or already merged.`
    );
    this.name = "MergePartyNotFoundError";
  }
}

export async function createMergeRequest(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateMergeRequestInput,
  correlationId?: string
): Promise<MergeRequestView> {
  assertMergeRequestIsValid({
    sourceProfileId: input.sourceProfileId,
    targetProfileId: input.targetProfileId
  });

  const source = await fetchPartyForMerge(tx, input.sourceProfileId);
  const target = await fetchPartyForMerge(tx, input.targetProfileId);

  if (
    !source ||
    source.deleted_at !== null ||
    source.merged_into_profile_id !== null
  ) {
    throw new MergePartyNotFoundError("source");
  }

  if (
    !target ||
    target.deleted_at !== null ||
    target.merged_into_profile_id !== null
  ) {
    throw new MergePartyNotFoundError("target");
  }

  // Cross-tenant guard — re-validated here even though both profiles were
  // just fetched by primary key without a tenant filter (the `FOR UPDATE`
  // lookup above intentionally omits `tenant_id` so a cross-tenant id
  // produces a clear, auditable rejection below rather than a silent "not
  // found" that could be mistaken for a missing-row bug). Issue #748
  // security requirement: cross-tenant matching/merge is strictly
  // prohibited.
  assertSameTenant(tenantId, source.tenant_id, target.tenant_id);

  const fieldConflicts = computeFieldConflicts(
    toSnapshot(source),
    toSnapshot(target)
  );
  const referenceImpact = await computeReferenceImpactSummary(
    tx,
    tenantId,
    input.sourceProfileId
  );
  const requiresApproval = computeRequiresApproval();

  const rows = (await tx`
    INSERT INTO awcms_mini_profile_merge_requests
      (tenant_id, source_profile_id, target_profile_id, reason, requires_approval,
       field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, requested_by)
    VALUES (
      ${tenantId}, ${input.sourceProfileId}, ${input.targetProfileId}, ${input.reason},
      ${requiresApproval}, ${JSON.stringify(fieldConflicts)}::jsonb,
      ${JSON.stringify(referenceImpact)}::jsonb, ${input.duplicateCandidateId}, ${actorTenantUserId}
    )
    RETURNING id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
  `) as MergeRequestRow[];

  const view = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "merge_requested",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "warning",
    message: "Profile merge requested.",
    attributes: {
      sourceProfileId: view.sourceProfileId,
      targetProfileId: view.targetProfileId,
      referenceImpactTotal: referenceImpact.totalEntityLinks
    },
    correlationId
  });

  recordCounter("profile_identity_merge_total", { outcome: "requested" });

  return view;
}

export async function fetchMergeRequestById(
  tx: Bun.SQL,
  tenantId: string,
  mergeRequestId: string
): Promise<MergeRequestView | null> {
  const rows = (await tx`
    SELECT id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
    FROM awcms_mini_profile_merge_requests
    WHERE tenant_id = ${tenantId} AND id = ${mergeRequestId}
  `) as MergeRequestRow[];

  const row = rows[0];
  return row ? toView(row) : null;
}

export async function listMergeRequests(
  tx: Bun.SQL,
  tenantId: string,
  options: { status?: string } = {}
): Promise<MergeRequestView[]> {
  const status = options.status ?? null;

  const rows = (await tx`
    SELECT id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
    FROM awcms_mini_profile_merge_requests
    WHERE tenant_id = ${tenantId}
      AND (${status}::text IS NULL OR status = ${status})
    ORDER BY created_at DESC
  `) as MergeRequestRow[];

  return rows.map(toView);
}

export type DecideMergeRequestResult =
  | { outcome: "not_found" }
  | { outcome: "already_decided"; view: MergeRequestView }
  | { outcome: "decided"; view: MergeRequestView };

export async function decideMergeRequest(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mergeRequestId: string,
  decision: "approved" | "rejected",
  reason: string | null,
  correlationId?: string
): Promise<DecideMergeRequestResult> {
  const rows = (await tx`
    SELECT id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
    FROM awcms_mini_profile_merge_requests
    WHERE tenant_id = ${tenantId} AND id = ${mergeRequestId}
    FOR UPDATE
  `) as MergeRequestRow[];
  const existing = rows[0];

  if (!existing) {
    return { outcome: "not_found" };
  }

  if (existing.status !== "pending") {
    return { outcome: "already_decided", view: toView(existing) };
  }

  const updatedRows = (await tx`
    UPDATE awcms_mini_profile_merge_requests
    SET status = ${decision}, decided_by = ${actorTenantUserId}, decided_at = now(),
        reason = COALESCE(${reason}, reason), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${mergeRequestId}
    RETURNING id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
  `) as MergeRequestRow[];

  const view = toView(updatedRows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "merge_decided",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "warning",
    message: `Profile merge request ${decision}.`,
    attributes: { decision, reason },
    correlationId
  });

  recordCounter("profile_identity_merge_total", { outcome: decision });

  return { outcome: "decided", view };
}

export type ExecuteMergeRequestResult =
  | { outcome: "not_found" }
  | { outcome: "not_approved"; view: MergeRequestView }
  | { outcome: "already_executed"; view: MergeRequestView }
  | {
      outcome: "executed";
      view: MergeRequestView;
      entityLinksRepointedCount: number;
    };

/**
 * Executes an APPROVED merge request. This is the real, state-changing
 * operation the issue's cross-tenant-merge prohibition guards — every
 * check here re-validates against freshly re-fetched rows inside THIS
 * transaction, never trusting anything computed at request-creation time.
 *
 * Concurrency: `SELECT ... FOR UPDATE` on the merge request row serializes
 * any second concurrent execution attempt (whether it carries the same
 * `Idempotency-Key` or a different one) — the second caller blocks until
 * the first commits, then observes `status = 'completed'` and returns the
 * already-executed result instead of repeating the merge.
 */
export async function executeMergeRequest(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mergeRequestId: string,
  correlationId?: string
): Promise<ExecuteMergeRequestResult> {
  const rows = (await tx`
    SELECT id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
    FROM awcms_mini_profile_merge_requests
    WHERE tenant_id = ${tenantId} AND id = ${mergeRequestId}
    FOR UPDATE
  `) as MergeRequestRow[];
  const existing = rows[0];

  if (!existing) {
    return { outcome: "not_found" };
  }

  if (existing.status === "completed") {
    return { outcome: "already_executed", view: toView(existing) };
  }

  if (existing.status !== "approved") {
    return { outcome: "not_approved", view: toView(existing) };
  }

  const source = await fetchPartyForMerge(tx, existing.source_profile_id);
  const target = await fetchPartyForMerge(tx, existing.target_profile_id);

  if (
    !source ||
    source.deleted_at !== null ||
    source.merged_into_profile_id !== null
  ) {
    throw new MergePartyNotFoundError("source");
  }

  if (
    !target ||
    target.deleted_at !== null ||
    target.merged_into_profile_id !== null
  ) {
    throw new MergePartyNotFoundError("target");
  }

  // CRITICAL — cross-tenant merge is strictly prohibited (Issue #748).
  // Re-validated here at EXECUTION time against freshly re-fetched rows,
  // never trusting the merge request's own `tenant_id` column or anything
  // computed when the request was created.
  assertSameTenant(tenantId, source.tenant_id, target.tenant_id);

  const fieldConflicts = computeFieldConflicts(
    toSnapshot(source),
    toSnapshot(target)
  );
  const referenceImpact = await computeReferenceImpactSummary(
    tx,
    tenantId,
    source.id
  );

  const repointedRows = await tx`
    UPDATE awcms_mini_profile_entity_links AS src
    SET profile_id = ${target.id}
    WHERE src.tenant_id = ${tenantId} AND src.profile_id = ${source.id}
      AND NOT EXISTS (
        SELECT 1 FROM awcms_mini_profile_entity_links tgt
        WHERE tgt.tenant_id = src.tenant_id AND tgt.profile_id = ${target.id}
          AND tgt.module_key = src.module_key AND tgt.entity_type = src.entity_type
          AND tgt.entity_id = src.entity_id
      )
    RETURNING src.id
  `;
  const entityLinksRepointedCount = repointedRows.length;

  // Any entity links left on the source are pure duplicates of a link the
  // target already has (same module/entity type/entity id) — safe to
  // remove now that the target already carries the equivalent reference.
  await tx`
    DELETE FROM awcms_mini_profile_entity_links
    WHERE tenant_id = ${tenantId} AND profile_id = ${source.id}
  `;

  const mergeReason = `Merged into profile ${target.id}.`;

  await tx`
    UPDATE awcms_mini_profiles
    SET status = 'merged', merged_into_profile_id = ${target.id},
        deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${mergeReason},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${source.id}
  `;

  const finalRows = (await tx`
    UPDATE awcms_mini_profile_merge_requests
    SET status = 'completed', executed_by = ${actorTenantUserId}, executed_at = now(),
        field_conflict_snapshot = ${JSON.stringify(fieldConflicts)}::jsonb,
        reference_impact_snapshot = ${JSON.stringify(referenceImpact)}::jsonb,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${mergeRequestId}
    RETURNING id, source_profile_id, target_profile_id, status, reason,
      requires_approval, requested_by, decided_by, decided_at, executed_by, executed_at,
      field_conflict_snapshot, reference_impact_snapshot, duplicate_candidate_id, created_at, updated_at
  `) as MergeRequestRow[];
  const view = toView(finalRows[0]!);

  await tx`
    INSERT INTO awcms_mini_profile_merge_history
      (tenant_id, merge_request_id, survivor_profile_id, loser_profile_id, executed_by,
       field_conflict_snapshot, reference_impact_snapshot, entity_links_repointed_count)
    VALUES (
      ${tenantId}, ${mergeRequestId}, ${target.id}, ${source.id}, ${actorTenantUserId},
      ${JSON.stringify(fieldConflicts)}::jsonb, ${JSON.stringify(referenceImpact)}::jsonb,
      ${entityLinksRepointedCount}
    )
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: PROFILE_MERGED_EVENT_TYPE,
    eventVersion: PROFILE_MERGED_EVENT_VERSION,
    aggregateType: "profile",
    aggregateId: target.id,
    producerModule: "profile_identity",
    actorTenantUserId,
    payload: {
      mergeRequestId,
      survivorProfileId: target.id,
      loserProfileId: source.id,
      entityLinksRepointedCount
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "merge_executed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: mergeRequestId,
    severity: "critical",
    message: "Profile merge executed.",
    attributes: {
      survivorProfileId: target.id,
      loserProfileId: source.id,
      entityLinksRepointedCount
    },
    correlationId
  });

  recordCounter("profile_identity_merge_total", { outcome: "executed" });

  return { outcome: "executed", view, entityLinksRepointedCount };
}
