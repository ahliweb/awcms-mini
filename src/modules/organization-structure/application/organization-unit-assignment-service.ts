/**
 * Organization-unit assignment persistence + audit (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). `tenantUserId` references
 * `identity_access`'s `awcms_mini_tenant_users` — re-validated as
 * belonging to THIS tenant at write time (same "re-check tenant ownership
 * of a referenced row before insert" convention `business-scope-
 * assignment-service.ts` established for its own `tenantUserId` check).
 * This does NOT create a duplicate person/party registry (ADR-0013 §4
 * no-shared-table-write rule) — it only references the existing row.
 *
 * Ending an assignment (`endOrganizationUnitAssignment`) NEVER deletes the
 * row or rewrites its historical `effectiveFrom`/`effectiveTo` — it only
 * transitions `status` to `ended` (issue #749: "Reorganization does not
 * rewrite historical assignments").
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  ORGANIZATION_STRUCTURE_ASSIGNMENT_CREATED_EVENT_TYPE,
  ORGANIZATION_STRUCTURE_ASSIGNMENT_ENDED_EVENT_TYPE,
  ORGANIZATION_STRUCTURE_EVENT_VERSION
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  DEFAULT_EXPIRING_SOON_WINDOW_DAYS,
  validateCreateOrganizationUnitAssignmentInput,
  validateEndOrganizationUnitAssignmentInput,
  type CreateOrganizationUnitAssignmentInput,
  type EndOrganizationUnitAssignmentInput,
  type OrganizationUnitAssignmentValidationError
} from "../domain/organization-unit-assignment";

const MODULE_KEY = "organization_structure";

export type OrganizationUnitAssignmentRow = {
  id: string;
  tenantId: string;
  organizationUnitId: string;
  tenantUserId: string;
  positionLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: "active" | "ended";
  reason: string | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type OrganizationUnitAssignmentDbRow = {
  id: string;
  tenant_id: string;
  organization_unit_id: string;
  tenant_user_id: string;
  position_label: string | null;
  effective_from: Date;
  effective_to: Date | null;
  status: "active" | "ended";
  reason: string | null;
  ended_at: Date | null;
  end_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function toRow(
  row: OrganizationUnitAssignmentDbRow
): OrganizationUnitAssignmentRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationUnitId: row.organization_unit_id,
    tenantUserId: row.tenant_user_id,
    positionLabel: row.position_label,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    reason: row.reason,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type CreateOrganizationUnitAssignmentResult =
  | { ok: true; assignment: OrganizationUnitAssignmentRow }
  | {
      ok: false;
      reason: "validation";
      errors: OrganizationUnitAssignmentValidationError[];
    }
  | { ok: false; reason: "unit_not_found" }
  | { ok: false; reason: "tenant_user_not_found" };

export async function createOrganizationUnitAssignment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateOrganizationUnitAssignmentInput,
  correlationId?: string
): Promise<CreateOrganizationUnitAssignmentResult> {
  const errors = validateCreateOrganizationUnitAssignmentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const unitRows = (await tx`
    SELECT id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${input.organizationUnitId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (!unitRows[0]) {
    return { ok: false, reason: "unit_not_found" };
  }

  const tenantUserRows = (await tx`
    SELECT id FROM awcms_mini_tenant_users
    WHERE tenant_id = ${tenantId} AND id = ${input.tenantUserId}
  `) as { id: string }[];
  if (!tenantUserRows[0]) {
    return { ok: false, reason: "tenant_user_not_found" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_organization_unit_assignments
      (tenant_id, organization_unit_id, tenant_user_id, position_label, effective_from,
       effective_to, reason, assigned_by_tenant_user_id)
    VALUES (
      ${tenantId}, ${input.organizationUnitId}, ${input.tenantUserId}, ${input.positionLabel},
      ${input.effectiveFrom}, ${input.effectiveTo}, ${input.reason}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, organization_unit_id, tenant_user_id, position_label,
      effective_from, effective_to, status, reason, ended_at, end_reason, created_at, updated_at
  `) as OrganizationUnitAssignmentDbRow[];

  const assignment = toRow(rows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_ASSIGNMENT_CREATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "organization_unit_assignment",
    aggregateId: assignment.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      organizationUnitId: assignment.organizationUnitId,
      positionLabel: assignment.positionLabel
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "organization_unit_assignment",
    resourceId: assignment.id,
    severity: "info",
    message: "Organization-unit assignment created.",
    attributes: {
      organizationUnitId: assignment.organizationUnitId,
      tenantUserId: assignment.tenantUserId
    },
    correlationId
  });

  return { ok: true, assignment };
}

export type EndOrganizationUnitAssignmentResult =
  | { ok: true; assignment: OrganizationUnitAssignmentRow }
  | {
      ok: false;
      reason: "validation";
      errors: OrganizationUnitAssignmentValidationError[];
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_ended" };

export async function endOrganizationUnitAssignment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  assignmentId: string,
  input: EndOrganizationUnitAssignmentInput,
  correlationId?: string
): Promise<EndOrganizationUnitAssignmentResult> {
  const errors = validateEndOrganizationUnitAssignmentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, status FROM awcms_mini_organization_unit_assignments
    WHERE tenant_id = ${tenantId} AND id = ${assignmentId}
  `) as { id: string; status: string }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "active") {
    return { ok: false, reason: "already_ended" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_unit_assignments
    SET status = 'ended', effective_to = COALESCE(effective_to, now()), ended_at = now(),
        ended_by_tenant_user_id = ${actorTenantUserId}, end_reason = ${input.endReason},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${assignmentId} AND status = 'active'
    RETURNING id, tenant_id, organization_unit_id, tenant_user_id, position_label,
      effective_from, effective_to, status, reason, ended_at, end_reason, created_at, updated_at
  `) as OrganizationUnitAssignmentDbRow[];

  if (!rows[0]) {
    // Lost a race against a concurrent end — same convention
    // `business-scope-assignment-service.ts`'s `revokeBusinessScopeAssignment`
    // documents for its own equivalent race.
    return { ok: false, reason: "already_ended" };
  }

  const assignment = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_ASSIGNMENT_ENDED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "organization_unit_assignment",
    aggregateId: assignment.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { endReason: input.endReason }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "revoke",
    resourceType: "organization_unit_assignment",
    resourceId: assignment.id,
    severity: "warning",
    message: "Organization-unit assignment ended.",
    attributes: { endReason: input.endReason },
    correlationId
  });

  return { ok: true, assignment };
}

export type ListOrganizationUnitAssignmentsFilter = {
  organizationUnitId?: string;
  tenantUserId?: string;
  status?: "active" | "ended";
  asOf?: Date;
};

export async function listOrganizationUnitAssignments(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListOrganizationUnitAssignmentsFilter = {}
): Promise<OrganizationUnitAssignmentRow[]> {
  const asOf = filter.asOf ?? null;

  const rows = (await tx`
    SELECT id, tenant_id, organization_unit_id, tenant_user_id, position_label,
      effective_from, effective_to, status, reason, ended_at, end_reason, created_at, updated_at
    FROM awcms_mini_organization_unit_assignments
    WHERE tenant_id = ${tenantId}
      AND (${filter.organizationUnitId ?? null}::uuid IS NULL OR organization_unit_id = ${filter.organizationUnitId ?? null})
      AND (${filter.tenantUserId ?? null}::uuid IS NULL OR tenant_user_id = ${filter.tenantUserId ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (
        ${asOf}::timestamptz IS NULL
        OR (effective_from <= ${asOf} AND (effective_to IS NULL OR effective_to > ${asOf}))
      )
    ORDER BY created_at DESC
    LIMIT 200
  `) as OrganizationUnitAssignmentDbRow[];

  return rows.map(toRow);
}

/** Count of currently-active assignments whose `effectiveTo` falls within the near-term expiring-soon window — feeds the `organization_structure_assignments_expiring_total` gauge. Metric only, no auto-expiry action (issue #749 scope). */
export async function countExpiringSoonAssignments(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  windowDays: number = DEFAULT_EXPIRING_SOON_WINDOW_DAYS
): Promise<number> {
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const rows = (await tx`
    SELECT count(*)::int AS count
    FROM awcms_mini_organization_unit_assignments
    WHERE tenant_id = ${tenantId}
      AND status = 'active'
      AND effective_to IS NOT NULL
      AND effective_to > ${now}
      AND effective_to <= ${windowEnd}
  `) as { count: number }[];

  return rows[0]?.count ?? 0;
}
