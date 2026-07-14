/**
 * Organization-unit-type persistence + audit (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Low-risk admin-config resource
 * (same class as `social-publish-rule-directory.ts`'s rules) — audited at
 * `info` severity, no idempotency requirement (not classified high-risk:
 * `create`/`update` are not in `HIGH_RISK_ACTIONS`).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateCreateOrganizationUnitTypeInput,
  validateUpdateOrganizationUnitTypeInput,
  type CreateOrganizationUnitTypeInput,
  type OrganizationUnitTypeValidationError,
  type UpdateOrganizationUnitTypeInput
} from "../domain/organization-unit-type";

const MODULE_KEY = "organization_structure";

export type OrganizationUnitTypeRow = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type OrganizationUnitTypeDbRow = {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: OrganizationUnitTypeDbRow): OrganizationUnitTypeRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export type CreateOrganizationUnitTypeResult =
  | { ok: true; unitType: OrganizationUnitTypeRow }
  | {
      ok: false;
      reason: "validation";
      errors: OrganizationUnitTypeValidationError[];
    }
  | { ok: false; reason: "duplicate_code" };

export async function createOrganizationUnitType(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateOrganizationUnitTypeInput,
  correlationId?: string
): Promise<CreateOrganizationUnitTypeResult> {
  const errors = validateCreateOrganizationUnitTypeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id FROM awcms_mini_organization_unit_types
    WHERE tenant_id = ${tenantId} AND code = ${input.code} AND deleted_at IS NULL
  `) as { id: string }[];

  if (existingRows[0]) {
    return { ok: false, reason: "duplicate_code" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_organization_unit_types
      (tenant_id, code, name, description, created_by, updated_by)
    VALUES (${tenantId}, ${input.code}, ${input.name}, ${input.description}, ${actorTenantUserId}, ${actorTenantUserId})
    RETURNING id, tenant_id, code, name, description, status, created_at, updated_at, deleted_at
  `) as OrganizationUnitTypeDbRow[];

  const unitType = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "organization_unit_type",
    resourceId: unitType.id,
    severity: "info",
    message: `Organization-unit type "${unitType.code}" created.`,
    attributes: { code: unitType.code },
    correlationId
  });

  return { ok: true, unitType };
}

export type UpdateOrganizationUnitTypeResult =
  | { ok: true; unitType: OrganizationUnitTypeRow }
  | {
      ok: false;
      reason: "validation";
      errors: OrganizationUnitTypeValidationError[];
    }
  | { ok: false; reason: "not_found" };

export async function updateOrganizationUnitType(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitTypeId: string,
  input: UpdateOrganizationUnitTypeInput,
  correlationId?: string
): Promise<UpdateOrganizationUnitTypeResult> {
  const errors = validateUpdateOrganizationUnitTypeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_unit_types
    SET name = ${input.name}, description = ${input.description},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId} AND deleted_at IS NULL
    RETURNING id, tenant_id, code, name, description, status, created_at, updated_at, deleted_at
  `) as OrganizationUnitTypeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const unitType = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "organization_unit_type",
    resourceId: unitType.id,
    severity: "info",
    message: `Organization-unit type "${unitType.code}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, unitType };
}

export type DeleteOrganizationUnitTypeResult =
  | { ok: true; unitType: OrganizationUnitTypeRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deleted" };

export async function deleteOrganizationUnitType(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitTypeId: string,
  deleteReason: string | null,
  correlationId?: string
): Promise<DeleteOrganizationUnitTypeResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_organization_unit_types
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at !== null) {
    return { ok: false, reason: "already_deleted" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_unit_types
    SET status = 'inactive', deleted_at = now(), deleted_by = ${actorTenantUserId},
        delete_reason = ${deleteReason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId} AND deleted_at IS NULL
    RETURNING id, tenant_id, code, name, description, status, created_at, updated_at, deleted_at
  `) as OrganizationUnitTypeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deleted" };
  }

  const unitType = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "organization_unit_type",
    resourceId: unitType.id,
    severity: "warning",
    message: `Organization-unit type "${unitType.code}" soft-deleted.`,
    attributes: { deleteReason },
    correlationId
  });

  return { ok: true, unitType };
}

export type RestoreOrganizationUnitTypeResult =
  | { ok: true; unitType: OrganizationUnitTypeRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deleted" };

export async function restoreOrganizationUnitType(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  unitTypeId: string,
  correlationId?: string
): Promise<RestoreOrganizationUnitTypeResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_organization_unit_types
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at === null) {
    return { ok: false, reason: "not_deleted" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_organization_unit_types
    SET status = 'active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId} AND deleted_at IS NOT NULL
    RETURNING id, tenant_id, code, name, description, status, created_at, updated_at, deleted_at
  `) as OrganizationUnitTypeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deleted" };
  }

  const unitType = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "organization_unit_type",
    resourceId: unitType.id,
    severity: "info",
    message: `Organization-unit type "${unitType.code}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, unitType };
}

export async function fetchOrganizationUnitTypeById(
  tx: Bun.SQL,
  tenantId: string,
  unitTypeId: string
): Promise<OrganizationUnitTypeRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, code, name, description, status, created_at, updated_at, deleted_at
    FROM awcms_mini_organization_unit_types
    WHERE tenant_id = ${tenantId} AND id = ${unitTypeId}
  `) as OrganizationUnitTypeDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export async function listOrganizationUnitTypes(
  tx: Bun.SQL,
  tenantId: string,
  includeDeleted = false
): Promise<OrganizationUnitTypeRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, code, name, description, status, created_at, updated_at, deleted_at
    FROM awcms_mini_organization_unit_types
    WHERE tenant_id = ${tenantId}
      AND (${includeDeleted} OR deleted_at IS NULL)
    ORDER BY code ASC
    LIMIT 200
  `) as OrganizationUnitTypeDbRow[];

  return rows.map(toRow);
}
