/**
 * Document classification persistence + audit (Issue #751). Same
 * "not-found/invalid-state is a discriminated union, never a thrown
 * error" convention `organization-structure/application/legal-entity-
 * directory.ts` establishes for this codebase. The column list is
 * repeated literally at each query site (not factored into a shared
 * `tx.unsafe()` fragment) — same convention `tenant-domain-directory.ts`
 * documents ("every query stays a single self-contained tagged
 * template").
 *
 * Deactivation (`deactivateClassification`) is the "delete" for this
 * resource — soft-delete only, never a hard DELETE row.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateCreateClassificationInput,
  validateDeactivateClassificationInput,
  validateUpdateClassificationInput,
  type CreateClassificationInput,
  type DeactivateClassificationInput,
  type UpdateClassificationInput
} from "../domain/document-classification";
import type { DocumentValidationError } from "../domain/errors";

const MODULE_KEY = "document_infrastructure";

export type DocumentClassificationRow = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  confidentialityLevel: string;
  retentionReference: string | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type DocumentClassificationDbRow = {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  confidentiality_level: string;
  retention_reference: string | null;
  status: "active" | "inactive";
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: DocumentClassificationDbRow): DocumentClassificationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    confidentialityLevel: row.confidentiality_level,
    retentionReference: row.retention_reference,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export type CreateClassificationResult =
  | { ok: true; classification: DocumentClassificationRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] };

export async function createClassification(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateClassificationInput,
  correlationId?: string
): Promise<CreateClassificationResult> {
  const errors = validateCreateClassificationInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_document_classifications
      (tenant_id, code, name, description, confidentiality_level,
       retention_reference, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.code}, ${input.name}, ${input.description},
      ${input.confidentialityLevel}, ${input.retentionReference},
      ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, code, name, description, confidentiality_level,
      retention_reference, status, created_at, updated_at, deleted_at
  `) as DocumentClassificationDbRow[];

  const classification = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "document_classification",
    resourceId: classification.id,
    severity: "info",
    message: `Document classification "${classification.code}" created.`,
    attributes: { confidentialityLevel: classification.confidentialityLevel },
    correlationId
  });

  return { ok: true, classification };
}

export type UpdateClassificationResult =
  | { ok: true; classification: DocumentClassificationRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" };

export async function updateClassification(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  classificationId: string,
  input: UpdateClassificationInput,
  correlationId?: string
): Promise<UpdateClassificationResult> {
  const errors = validateUpdateClassificationInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_document_classifications
    SET name = ${input.name},
        description = ${input.description},
        confidentiality_level = ${input.confidentialityLevel},
        retention_reference = ${input.retentionReference},
        updated_by = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${classificationId} AND deleted_at IS NULL
    RETURNING id, tenant_id, code, name, description, confidentiality_level,
      retention_reference, status, created_at, updated_at, deleted_at
  `) as DocumentClassificationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const classification = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "document_classification",
    resourceId: classification.id,
    severity: "info",
    message: `Document classification "${classification.code}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, classification };
}

export type DeactivateClassificationResult =
  | { ok: true; classification: DocumentClassificationRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deactivated" };

export async function deactivateClassification(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  classificationId: string,
  input: DeactivateClassificationInput,
  correlationId?: string
): Promise<DeactivateClassificationResult> {
  const errors = validateDeactivateClassificationInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_document_classifications
    WHERE tenant_id = ${tenantId} AND id = ${classificationId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at !== null) {
    return { ok: false, reason: "already_deactivated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_document_classifications
    SET status = 'inactive', deleted_at = now(), deleted_by = ${actorTenantUserId},
        delete_reason = ${input.deleteReason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${classificationId} AND deleted_at IS NULL
    RETURNING id, tenant_id, code, name, description, confidentiality_level,
      retention_reference, status, created_at, updated_at, deleted_at
  `) as DocumentClassificationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deactivated" };
  }

  const classification = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "document_classification",
    resourceId: classification.id,
    severity: "warning",
    message: `Document classification "${classification.code}" deactivated.`,
    attributes: { deleteReason: input.deleteReason },
    correlationId
  });

  return { ok: true, classification };
}

export type RestoreClassificationResult =
  | { ok: true; classification: DocumentClassificationRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deactivated" };

export async function restoreClassification(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  classificationId: string,
  correlationId?: string
): Promise<RestoreClassificationResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_document_classifications
    WHERE tenant_id = ${tenantId} AND id = ${classificationId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at === null) {
    return { ok: false, reason: "not_deactivated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_document_classifications
    SET status = 'active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${classificationId} AND deleted_at IS NOT NULL
    RETURNING id, tenant_id, code, name, description, confidentiality_level,
      retention_reference, status, created_at, updated_at, deleted_at
  `) as DocumentClassificationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deactivated" };
  }

  const classification = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "document_classification",
    resourceId: classification.id,
    severity: "warning",
    message: `Document classification "${classification.code}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, classification };
}

export async function fetchClassificationById(
  tx: Bun.SQL,
  tenantId: string,
  classificationId: string
): Promise<DocumentClassificationRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, code, name, description, confidentiality_level,
      retention_reference, status, created_at, updated_at, deleted_at
    FROM awcms_mini_document_classifications
    WHERE tenant_id = ${tenantId} AND id = ${classificationId}
  `) as DocumentClassificationDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export type ListClassificationsFilter = {
  status?: "active" | "inactive";
  includeDeleted?: boolean;
};

/** Bounded list (`LIMIT 200`), newest first. */
export async function listClassifications(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListClassificationsFilter = {}
): Promise<DocumentClassificationRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, code, name, description, confidentiality_level,
      retention_reference, status, created_at, updated_at, deleted_at
    FROM awcms_mini_document_classifications
    WHERE tenant_id = ${tenantId}
      AND (${filter.includeDeleted ?? false} OR deleted_at IS NULL)
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as DocumentClassificationDbRow[];

  return rows.map(toRow);
}
