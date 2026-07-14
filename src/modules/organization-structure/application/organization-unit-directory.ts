/**
 * Organization-unit persistence + audit (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). `legalEntityId`/`unitTypeId` are
 * ordinary FKs — re-validated as belonging to the SAME tenant (and, for
 * the legal entity, not soft-deleted) at write time, never trusted from
 * request input alone (same "re-validate the referenced row's tenant_id
 * before insert" convention `business-scope-assignment-service.ts`
 * established for its own `tenantUserId`/`roleId` checks) — cross-tenant
 * references are rejected here, not just by RLS.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  ORGANIZATION_STRUCTURE_EVENT_VERSION,
  ORGANIZATION_STRUCTURE_UNIT_CREATED_EVENT_TYPE,
  ORGANIZATION_STRUCTURE_UNIT_DEACTIVATED_EVENT_TYPE,
  ORGANIZATION_STRUCTURE_UNIT_UPDATED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  encodeKeysetCursor,
  decodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  validateCreateOrganizationUnitInput,
  validateUpdateOrganizationUnitInput,
  type CreateOrganizationUnitInput,
  type OrganizationUnitValidationError,
  type UpdateOrganizationUnitInput
} from "../domain/organization-unit";

const MODULE_KEY = "organization_structure";
const PAGE_SIZE = 50;

export type OrganizationUnitRow = {
  id: string;
  tenantId: string;
  legalEntityId: string | null;
  unitTypeId: string | null;
  code: string;
  name: string;
  status: "active" | "inactive";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type OrganizationUnitDbRow = {
  id: string;
  tenant_id: string;
  legal_entity_id: string | null;
  unit_type_id: string | null;
  code: string;
  name: string;
  status: "active" | "inactive";
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: OrganizationUnitDbRow): OrganizationUnitRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    unitTypeId: row.unit_type_id,
    code: row.code,
    name: row.name,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

async function assertLegalEntityBelongsToTenant(
  tx: Bun.SQL,
  tenantId: string,
  legalEntityId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT id FROM awcms_mini_legal_entities
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId} AND deleted_at IS NULL
  `) as { id: string }[];
  return rows.length > 0;
}

async function assertUnitTypeBelongsToTenant(
  tx: Bun.SQL,
  tenantId: string,
  unitTypeId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT id FROM awcms_mini_organization_unit_types
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId} AND deleted_at IS NULL
  `) as { id: string }[];
  return rows.length > 0;
}

export type CreateOrganizationUnitResult =
  | { ok: true; unit: OrganizationUnitRow }
  | {
      ok: false;
      reason: "validation";
      errors: OrganizationUnitValidationError[];
    }
  | { ok: false; reason: "legal_entity_invalid" }
  | { ok: false; reason: "unit_type_invalid" }
  | { ok: false; reason: "duplicate_code" };

export async function createOrganizationUnit(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateOrganizationUnitInput,
  correlationId?: string
): Promise<CreateOrganizationUnitResult> {
  const errors = validateCreateOrganizationUnitInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  if (input.legalEntityId !== null) {
    const valid = await assertLegalEntityBelongsToTenant(
      tx,
      tenantId,
      input.legalEntityId
    );
    if (!valid) {
      return { ok: false, reason: "legal_entity_invalid" };
    }
  }

  if (input.unitTypeId !== null) {
    const valid = await assertUnitTypeBelongsToTenant(
      tx,
      tenantId,
      input.unitTypeId
    );
    if (!valid) {
      return { ok: false, reason: "unit_type_invalid" };
    }
  }

  const existingRows = (await tx`
    SELECT id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND code = ${input.code} AND deleted_at IS NULL
  `) as { id: string }[];
  if (existingRows[0]) {
    return { ok: false, reason: "duplicate_code" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_organization_units
      (tenant_id, legal_entity_id, unit_type_id, code, name, effective_from, effective_to,
       created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.legalEntityId}, ${input.unitTypeId}, ${input.code}, ${input.name},
      ${input.effectiveFrom}, ${input.effectiveTo}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, legal_entity_id, unit_type_id, code, name, status,
      effective_from, effective_to, created_at, updated_at, deleted_at
  `) as OrganizationUnitDbRow[];

  const unit = toRow(rows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_UNIT_CREATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "organization_unit",
    aggregateId: unit.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { code: unit.code, name: unit.name }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "organization_unit",
    resourceId: unit.id,
    severity: "info",
    message: `Organization unit "${unit.code}" created.`,
    attributes: { code: unit.code },
    correlationId
  });

  return { ok: true, unit };
}

export type UpdateOrganizationUnitResult =
  | { ok: true; unit: OrganizationUnitRow }
  | {
      ok: false;
      reason: "validation";
      errors: OrganizationUnitValidationError[];
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "legal_entity_invalid" }
  | { ok: false; reason: "unit_type_invalid" };

export async function updateOrganizationUnit(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitId: string,
  input: UpdateOrganizationUnitInput,
  correlationId?: string
): Promise<UpdateOrganizationUnitResult> {
  const errors = validateUpdateOrganizationUnitInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  if (input.legalEntityId !== null) {
    const valid = await assertLegalEntityBelongsToTenant(
      tx,
      tenantId,
      input.legalEntityId
    );
    if (!valid) {
      return { ok: false, reason: "legal_entity_invalid" };
    }
  }

  if (input.unitTypeId !== null) {
    const valid = await assertUnitTypeBelongsToTenant(
      tx,
      tenantId,
      input.unitTypeId
    );
    if (!valid) {
      return { ok: false, reason: "unit_type_invalid" };
    }
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_units
    SET legal_entity_id = ${input.legalEntityId}, unit_type_id = ${input.unitTypeId},
        name = ${input.name}, effective_from = ${input.effectiveFrom},
        effective_to = ${input.effectiveTo}, updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${unitId} AND deleted_at IS NULL
    RETURNING id, tenant_id, legal_entity_id, unit_type_id, code, name, status,
      effective_from, effective_to, created_at, updated_at, deleted_at
  `) as OrganizationUnitDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const unit = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_UNIT_UPDATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "organization_unit",
    aggregateId: unit.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { code: unit.code, name: unit.name }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "organization_unit",
    resourceId: unit.id,
    severity: "info",
    message: `Organization unit "${unit.code}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, unit };
}

export type DeactivateOrganizationUnitResult =
  | { ok: true; unit: OrganizationUnitRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deactivated" };

export async function deactivateOrganizationUnit(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitId: string,
  deleteReason: string | null,
  correlationId?: string
): Promise<DeactivateOrganizationUnitResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${unitId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at !== null) {
    return { ok: false, reason: "already_deactivated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_units
    SET status = 'inactive', deleted_at = now(), deleted_by = ${actorTenantUserId},
        delete_reason = ${deleteReason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${unitId} AND deleted_at IS NULL
    RETURNING id, tenant_id, legal_entity_id, unit_type_id, code, name, status,
      effective_from, effective_to, created_at, updated_at, deleted_at
  `) as OrganizationUnitDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deactivated" };
  }

  const unit = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_UNIT_DEACTIVATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "organization_unit",
    aggregateId: unit.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { code: unit.code, deleteReason }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "organization_unit",
    resourceId: unit.id,
    severity: "warning",
    message: `Organization unit "${unit.code}" deactivated.`,
    attributes: { deleteReason },
    correlationId
  });

  return { ok: true, unit };
}

export type RestoreOrganizationUnitResult =
  | { ok: true; unit: OrganizationUnitRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deactivated" };

export async function restoreOrganizationUnit(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitId: string,
  correlationId?: string
): Promise<RestoreOrganizationUnitResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${unitId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at === null) {
    return { ok: false, reason: "not_deactivated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_units
    SET status = 'active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${unitId} AND deleted_at IS NOT NULL
    RETURNING id, tenant_id, legal_entity_id, unit_type_id, code, name, status,
      effective_from, effective_to, created_at, updated_at, deleted_at
  `) as OrganizationUnitDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deactivated" };
  }

  const unit = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "organization_unit",
    resourceId: unit.id,
    severity: "info",
    message: `Organization unit "${unit.code}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, unit };
}

export async function fetchOrganizationUnitById(
  tx: Bun.SQL,
  tenantId: string,
  unitId: string
): Promise<OrganizationUnitRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, legal_entity_id, unit_type_id, code, name, status,
      effective_from, effective_to, created_at, updated_at, deleted_at
    FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${unitId}
  `) as OrganizationUnitDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export type ListOrganizationUnitsFilter = {
  search?: string;
  legalEntityId?: string;
  status?: "active" | "inactive";
  cursor?: string;
  /** `true` only from the admin SSR page's own direct call, itself gated on the caller holding the `restore` permission (`admin/organization-structure/units.astro`, so the restore action has something to target) — the public `GET .../units` API route never sets this. */
  includeDeleted?: boolean;
};

export type ListOrganizationUnitsResult = {
  units: OrganizationUnitRow[];
  nextCursor: string | null;
};

/** Keyset-paginated list/search (Issue #749 acceptance criterion: "paginated where appropriate") — same `(created_at, id) < cursor` convention `_shared/keyset-pagination.ts` documents. `search` matches `code`/`name` case-insensitively. */
export async function listOrganizationUnits(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListOrganizationUnitsFilter = {}
): Promise<ListOrganizationUnitsResult> {
  let cursor: KeysetCursor | null = null;
  if (filter.cursor) {
    cursor = decodeKeysetCursor(filter.cursor);
    if (!cursor) {
      throw new Error("Malformed pagination cursor.");
    }
  }

  const searchPattern = filter.search ? `%${filter.search}%` : null;

  const rows = (await tx`
    SELECT id, tenant_id, legal_entity_id, unit_type_id, code, name, status,
      effective_from, effective_to, created_at, updated_at, deleted_at
    FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId}
      AND (${filter.includeDeleted ?? false} OR deleted_at IS NULL)
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.legalEntityId ?? null}::uuid IS NULL OR legal_entity_id = ${filter.legalEntityId ?? null})
      AND (
        ${searchPattern}::text IS NULL
        OR code ILIKE ${searchPattern}
        OR name ILIKE ${searchPattern}
      )
      AND (
        ${cursor?.createdAt ?? null}::timestamptz IS NULL
        OR (created_at, id) < (${cursor?.createdAt ?? null}, ${cursor?.id ?? null})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${PAGE_SIZE + 1}
  `) as OrganizationUnitDbRow[];

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page[page.length - 1];

  return {
    units: page.map(toRow),
    nextCursor:
      hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null
  };
}
