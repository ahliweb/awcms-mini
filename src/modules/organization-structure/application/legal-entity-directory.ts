/**
 * Legal-entity persistence + audit (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Same "not-found/invalid-state is a
 * discriminated union, never a thrown error" convention
 * `data-lifecycle/application/legal-hold-service.ts` documents.
 *
 * Deactivation (`deactivateLegalEntity`) is the "delete" for this
 * resource — soft-delete only, never a hard DELETE row (issue #749
 * security requirement: "Delete behavior is soft-delete/deactivate by
 * default; referenced/effective history is preserved").
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  ORGANIZATION_STRUCTURE_EVENT_VERSION,
  ORGANIZATION_STRUCTURE_LEGAL_ENTITY_CREATED_EVENT_TYPE,
  ORGANIZATION_STRUCTURE_LEGAL_ENTITY_DEACTIVATED_EVENT_TYPE,
  ORGANIZATION_STRUCTURE_LEGAL_ENTITY_UPDATED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  validateCreateLegalEntityInput,
  validateDeactivateLegalEntityInput,
  validateUpdateLegalEntityInput,
  type CreateLegalEntityInput,
  type DeactivateLegalEntityInput,
  type LegalEntityValidationError,
  type UpdateLegalEntityInput
} from "../domain/legal-entity";

const MODULE_KEY = "organization_structure";

export type LegalEntityRow = {
  id: string;
  tenantId: string;
  name: string;
  registrationIdentifier: string | null;
  registrationIdentifierLabel: string | null;
  status: "active" | "inactive";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type LegalEntityDbRow = {
  id: string;
  tenant_id: string;
  name: string;
  registration_identifier: string | null;
  registration_identifier_label: string | null;
  status: "active" | "inactive";
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: LegalEntityDbRow): LegalEntityRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    registrationIdentifier: row.registration_identifier,
    registrationIdentifierLabel: row.registration_identifier_label,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export type CreateLegalEntityResult =
  | { ok: true; legalEntity: LegalEntityRow }
  | { ok: false; reason: "validation"; errors: LegalEntityValidationError[] };

export async function createLegalEntity(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateLegalEntityInput,
  correlationId?: string
): Promise<CreateLegalEntityResult> {
  const errors = validateCreateLegalEntityInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_legal_entities
      (tenant_id, name, registration_identifier, registration_identifier_label,
       effective_from, effective_to, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.name}, ${input.registrationIdentifier}, ${input.registrationIdentifierLabel},
      ${input.effectiveFrom}, ${input.effectiveTo}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, name, registration_identifier, registration_identifier_label,
      status, effective_from, effective_to, created_at, updated_at, deleted_at
  `) as LegalEntityDbRow[];

  const legalEntity = toRow(rows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_LEGAL_ENTITY_CREATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "legal_entity",
    aggregateId: legalEntity.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { name: legalEntity.name, status: legalEntity.status }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "legal_entity",
    resourceId: legalEntity.id,
    severity: "info",
    message: `Legal entity "${legalEntity.name}" created.`,
    attributes: { status: legalEntity.status },
    correlationId
  });

  return { ok: true, legalEntity };
}

export type UpdateLegalEntityResult =
  | { ok: true; legalEntity: LegalEntityRow }
  | { ok: false; reason: "validation"; errors: LegalEntityValidationError[] }
  | { ok: false; reason: "not_found" };

export async function updateLegalEntity(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  legalEntityId: string,
  input: UpdateLegalEntityInput,
  correlationId?: string
): Promise<UpdateLegalEntityResult> {
  const errors = validateUpdateLegalEntityInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_legal_entities
    SET name = ${input.name},
        registration_identifier = ${input.registrationIdentifier},
        registration_identifier_label = ${input.registrationIdentifierLabel},
        effective_from = ${input.effectiveFrom},
        effective_to = ${input.effectiveTo},
        updated_by = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId} AND deleted_at IS NULL
    RETURNING id, tenant_id, name, registration_identifier, registration_identifier_label,
      status, effective_from, effective_to, created_at, updated_at, deleted_at
  `) as LegalEntityDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const legalEntity = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_LEGAL_ENTITY_UPDATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "legal_entity",
    aggregateId: legalEntity.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { name: legalEntity.name }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "legal_entity",
    resourceId: legalEntity.id,
    severity: "info",
    message: `Legal entity "${legalEntity.name}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, legalEntity };
}

export type DeactivateLegalEntityResult =
  | { ok: true; legalEntity: LegalEntityRow }
  | { ok: false; reason: "validation"; errors: LegalEntityValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deactivated" };

export async function deactivateLegalEntity(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  legalEntityId: string,
  input: DeactivateLegalEntityInput,
  correlationId?: string
): Promise<DeactivateLegalEntityResult> {
  const errors = validateDeactivateLegalEntityInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_legal_entities
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at !== null) {
    return { ok: false, reason: "already_deactivated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_legal_entities
    SET status = 'inactive', deleted_at = now(), deleted_by = ${actorTenantUserId},
        delete_reason = ${input.deleteReason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId} AND deleted_at IS NULL
    RETURNING id, tenant_id, name, registration_identifier, registration_identifier_label,
      status, effective_from, effective_to, created_at, updated_at, deleted_at
  `) as LegalEntityDbRow[];

  if (!rows[0]) {
    // Lost a race against a concurrent deactivate — same convention
    // `legal-hold-service.ts`'s `releaseLegalHold` documents.
    return { ok: false, reason: "already_deactivated" };
  }

  const legalEntity = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: ORGANIZATION_STRUCTURE_LEGAL_ENTITY_DEACTIVATED_EVENT_TYPE,
    eventVersion: ORGANIZATION_STRUCTURE_EVENT_VERSION,
    aggregateType: "legal_entity",
    aggregateId: legalEntity.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { name: legalEntity.name, deleteReason: input.deleteReason }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "legal_entity",
    resourceId: legalEntity.id,
    severity: "warning",
    message: `Legal entity "${legalEntity.name}" deactivated.`,
    attributes: { deleteReason: input.deleteReason },
    correlationId
  });

  return { ok: true, legalEntity };
}

export type RestoreLegalEntityResult =
  | { ok: true; legalEntity: LegalEntityRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deactivated" };

export async function restoreLegalEntity(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  legalEntityId: string,
  correlationId?: string
): Promise<RestoreLegalEntityResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_legal_entities
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at === null) {
    return { ok: false, reason: "not_deactivated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_legal_entities
    SET status = 'active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId} AND deleted_at IS NOT NULL
    RETURNING id, tenant_id, name, registration_identifier, registration_identifier_label,
      status, effective_from, effective_to, created_at, updated_at, deleted_at
  `) as LegalEntityDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deactivated" };
  }

  const legalEntity = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "legal_entity",
    resourceId: legalEntity.id,
    severity: "warning",
    message: `Legal entity "${legalEntity.name}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, legalEntity };
}

export async function fetchLegalEntityById(
  tx: Bun.SQL,
  tenantId: string,
  legalEntityId: string
): Promise<LegalEntityRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, name, registration_identifier, registration_identifier_label,
      status, effective_from, effective_to, created_at, updated_at, deleted_at
    FROM awcms_mini_legal_entities
    WHERE tenant_id = ${tenantId} AND id = ${legalEntityId}
  `) as LegalEntityDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export type ListLegalEntitiesFilter = {
  status?: "active" | "inactive";
  includeDeleted?: boolean;
};

/** Bounded list (`LIMIT 200`), newest first — same convention `listLegalHolds`/`listBusinessScopeAssignments` establish. */
export async function listLegalEntities(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListLegalEntitiesFilter = {}
): Promise<LegalEntityRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, name, registration_identifier, registration_identifier_label,
      status, effective_from, effective_to, created_at, updated_at, deleted_at
    FROM awcms_mini_legal_entities
    WHERE tenant_id = ${tenantId}
      AND (${filter.includeDeleted ?? false} OR deleted_at IS NULL)
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as LegalEntityDbRow[];

  return rows.map(toRow);
}
