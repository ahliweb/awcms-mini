/**
 * Document registry persistence + audit (Issue #751). Same "not-found/
 * invalid-state is a discriminated union, never a thrown error"
 * convention every other directory module in this codebase uses.
 *
 * `voidDocument`/`restoreDocument` are business-STATE transitions,
 * deliberately separate from `deleteDocument`/`restoreDocument`'s soft-
 * delete pair — see `sql/066`'s own header and `domain/document.ts`'s
 * `canVoidDocument`/`canRestoreVoidedDocument`. `restoreDocument` below
 * handles BOTH "undo a soft-delete" and "un-void a voided document"
 * (they can never apply to the same row at the same time — a soft-
 * deleted row's `deletedAt` is always non-null, and voiding requires
 * `deletedAt IS NULL` in the first place), reusing ONE `documents.restore`
 * permission for both, matching `sql/067`'s own documented rationale.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DOCUMENT_INFRASTRUCTURE_DOCUMENT_CREATED_EVENT_TYPE,
  DOCUMENT_INFRASTRUCTURE_DOCUMENT_RECLASSIFIED_EVENT_TYPE,
  DOCUMENT_INFRASTRUCTURE_DOCUMENT_RESTORED_EVENT_TYPE,
  DOCUMENT_INFRASTRUCTURE_DOCUMENT_VOIDED_EVENT_TYPE,
  DOCUMENT_INFRASTRUCTURE_EVENT_VERSION
} from "../../domain-event-runtime/domain/event-type-registry";
import { recordDocumentEvidence } from "./document-evidence-directory";
import {
  canRestoreVoidedDocument,
  canVoidDocument,
  validateCreateDocumentInput,
  validateDeleteDocumentInput,
  validateReclassifyDocumentInput,
  validateUpdateDocumentMetadataInput,
  validateVoidDocumentInput,
  type CreateDocumentInput,
  type DeleteDocumentInput,
  type DocumentStatus,
  type ReclassifyDocumentInput,
  type UpdateDocumentMetadataInput,
  type VoidDocumentInput
} from "../domain/document";
import type { DocumentValidationError } from "../domain/errors";

const MODULE_KEY = "document_infrastructure";

export type DocumentRow = {
  id: string;
  tenantId: string;
  ownerModuleKey: string;
  documentType: string;
  classificationId: string | null;
  status: DocumentStatus;
  title: string;
  summary: string | null;
  issuedAt: Date | null;
  effectiveAt: Date | null;
  confidentialityLevel: string;
  retentionReference: string | null;
  resourceType: string;
  resourceId: string;
  currentVersionNumber: number;
  voidReason: string | null;
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type DocumentDbRow = {
  id: string;
  tenant_id: string;
  owner_module_key: string;
  document_type: string;
  classification_id: string | null;
  status: DocumentStatus;
  title: string;
  summary: string | null;
  issued_at: Date | null;
  effective_at: Date | null;
  confidentiality_level: string;
  retention_reference: string | null;
  resource_type: string;
  resource_id: string;
  current_version_number: number;
  void_reason: string | null;
  voided_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: DocumentDbRow): DocumentRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerModuleKey: row.owner_module_key,
    documentType: row.document_type,
    classificationId: row.classification_id,
    status: row.status,
    title: row.title,
    summary: row.summary,
    issuedAt: row.issued_at,
    effectiveAt: row.effective_at,
    confidentialityLevel: row.confidentiality_level,
    retentionReference: row.retention_reference,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    currentVersionNumber: row.current_version_number,
    voidReason: row.void_reason,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export type CreateDocumentResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "classification_not_found" };

export async function createDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateDocumentInput,
  correlationId?: string
): Promise<CreateDocumentResult> {
  const errors = validateCreateDocumentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  if (input.classificationId !== null) {
    const classificationRows = (await tx`
      SELECT id FROM awcms_mini_document_classifications
      WHERE tenant_id = ${tenantId} AND id = ${input.classificationId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!classificationRows[0]) {
      return { ok: false, reason: "classification_not_found" };
    }
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_documents
      (tenant_id, owner_module_key, document_type, classification_id, title,
       summary, issued_at, effective_at, confidentiality_level, retention_reference,
       resource_type, resource_id, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.ownerModuleKey}, ${input.documentType}, ${input.classificationId},
      ${input.title}, ${input.summary}, ${input.issuedAt}, ${input.effectiveAt},
      ${input.confidentialityLevel}, ${input.retentionReference}, ${input.resourceType},
      ${input.resourceId}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
  `) as DocumentDbRow[];

  const document = toRow(rows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_CREATED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "document",
    aggregateId: document.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      ownerModuleKey: document.ownerModuleKey,
      documentType: document.documentType,
      resourceType: document.resourceType,
      resourceId: document.resourceId
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "document",
    resourceId: document.id,
    severity: "info",
    message: `Document "${document.title}" created.`,
    attributes: {
      ownerModuleKey: document.ownerModuleKey,
      documentType: document.documentType
    },
    correlationId
  });

  return { ok: true, document };
}

export type UpdateDocumentMetadataResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" };

export async function updateDocumentMetadata(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  input: UpdateDocumentMetadataInput,
  correlationId?: string
): Promise<UpdateDocumentMetadataResult> {
  const errors = validateUpdateDocumentMetadataInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_documents
    SET title = ${input.title},
        summary = ${input.summary},
        issued_at = ${input.issuedAt},
        effective_at = ${input.effectiveAt},
        updated_by = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NULL
    RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
  `) as DocumentDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const document = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "document",
    resourceId: document.id,
    severity: "info",
    message: `Document "${document.title}" metadata updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, document };
}

export type VoidDocumentResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_voidable" };

export async function voidDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  input: VoidDocumentInput,
  correlationId?: string
): Promise<VoidDocumentResult> {
  const errors = validateVoidDocumentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT status, deleted_at FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
    FOR UPDATE
  `) as { status: DocumentStatus; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (
    !canVoidDocument({
      status: existing.status,
      deletedAt: existing.deleted_at
    })
  ) {
    return { ok: false, reason: "not_voidable" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_documents
    SET status = 'void', void_reason = ${input.voidReason}, voided_at = now(),
        voided_by = ${actorTenantUserId}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NULL AND status <> 'void'
    RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
  `) as DocumentDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_voidable" };
  }

  const document = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_VOIDED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "document",
    aggregateId: document.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { voidReason: input.voidReason }
  });

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "document_voided",
    subjectType: "document",
    subjectId: document.id,
    documentId: document.id,
    actorTenantUserId,
    reason: input.voidReason,
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "void",
    resourceType: "document",
    resourceId: document.id,
    severity: "critical",
    message: `Document "${document.title}" voided.`,
    attributes: { voidReason: input.voidReason },
    correlationId
  });

  return { ok: true, document };
}

export type DeleteDocumentResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deleted" };

export async function deleteDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  input: DeleteDocumentInput,
  correlationId?: string
): Promise<DeleteDocumentResult> {
  const errors = validateDeleteDocumentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at !== null) {
    return { ok: false, reason: "already_deleted" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_documents
    SET deleted_at = now(), deleted_by = ${actorTenantUserId},
        delete_reason = ${input.deleteReason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NULL
    RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
  `) as DocumentDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deleted" };
  }

  const document = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "document",
    resourceId: document.id,
    severity: "warning",
    message: `Document "${document.title}" soft-deleted.`,
    attributes: { deleteReason: input.deleteReason },
    correlationId
  });

  return { ok: true, document };
}

export type RestoreDocumentResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_restorable" };

/** Restores a soft-deleted document, OR un-voids a voided document — see file header. */
export async function restoreDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  correlationId?: string
): Promise<RestoreDocumentResult> {
  const existingRows = (await tx`
    SELECT status, deleted_at FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
    FOR UPDATE
  `) as { status: DocumentStatus; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  if (existing.deleted_at !== null) {
    const rows = (await tx`
      UPDATE awcms_mini_documents
      SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
          restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
          updated_by = ${actorTenantUserId}
      WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NOT NULL
      RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
        status, title, summary, issued_at, effective_at, confidentiality_level,
        retention_reference, resource_type, resource_id, current_version_number,
        void_reason, voided_at, created_at, updated_at, deleted_at
    `) as DocumentDbRow[];

    if (!rows[0]) {
      return { ok: false, reason: "not_restorable" };
    }

    const document = toRow(rows[0]);
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: MODULE_KEY,
      action: "restore",
      resourceType: "document",
      resourceId: document.id,
      severity: "warning",
      message: `Document "${document.title}" restored (undo soft-delete).`,
      attributes: {},
      correlationId
    });
    return { ok: true, document };
  }

  if (
    !canRestoreVoidedDocument({
      status: existing.status,
      deletedAt: existing.deleted_at
    })
  ) {
    return { ok: false, reason: "not_restorable" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_documents
    SET status = 'active', void_reason = NULL, voided_at = NULL, voided_by = NULL,
        updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND status = 'void' AND deleted_at IS NULL
    RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
  `) as DocumentDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_restorable" };
  }

  const document = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_RESTORED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "document",
    aggregateId: document.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {}
  });

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "document_restored",
    subjectType: "document",
    subjectId: document.id,
    documentId: document.id,
    actorTenantUserId,
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "document",
    resourceId: document.id,
    severity: "warning",
    message: `Document "${document.title}" un-voided.`,
    attributes: {},
    correlationId
  });

  return { ok: true, document };
}

export type ReclassifyDocumentResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "classification_not_found" };

export async function reclassifyDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  input: ReclassifyDocumentInput,
  correlationId?: string
): Promise<ReclassifyDocumentResult> {
  const errors = validateReclassifyDocumentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  if (input.classificationId !== null) {
    const classificationRows = (await tx`
      SELECT id FROM awcms_mini_document_classifications
      WHERE tenant_id = ${tenantId} AND id = ${input.classificationId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!classificationRows[0]) {
      return { ok: false, reason: "classification_not_found" };
    }
  }

  const rows = (await tx`
    UPDATE awcms_mini_documents
    SET classification_id = ${input.classificationId},
        confidentiality_level = ${input.confidentialityLevel},
        updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NULL
    RETURNING id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
  `) as DocumentDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const document = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_DOCUMENT_RECLASSIFIED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "document",
    aggregateId: document.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      classificationId: document.classificationId,
      confidentialityLevel: document.confidentialityLevel,
      reason: input.reason
    }
  });

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "document_reclassified",
    subjectType: "document",
    subjectId: document.id,
    documentId: document.id,
    actorTenantUserId,
    reason: input.reason,
    metadata: {
      classificationId: document.classificationId,
      confidentialityLevel: document.confidentialityLevel
    },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "reclassify",
    resourceType: "document",
    resourceId: document.id,
    severity: "warning",
    message: `Document "${document.title}" reclassified.`,
    attributes: {
      classificationId: document.classificationId,
      confidentialityLevel: document.confidentialityLevel,
      reason: input.reason
    },
    correlationId
  });

  return { ok: true, document };
}

export async function fetchDocumentById(
  tx: Bun.SQL,
  tenantId: string,
  documentId: string
): Promise<DocumentRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
    FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
  `) as DocumentDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export type ListDocumentsFilter = {
  status?: DocumentStatus;
  ownerModuleKey?: string;
  resourceType?: string;
  resourceId?: string;
  includeDeleted?: boolean;
};

/** Bounded list (`LIMIT 200`), newest first. */
export async function listDocuments(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListDocumentsFilter = {}
): Promise<DocumentRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, owner_module_key, document_type, classification_id,
      status, title, summary, issued_at, effective_at, confidentiality_level,
      retention_reference, resource_type, resource_id, current_version_number,
      void_reason, voided_at, created_at, updated_at, deleted_at
    FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId}
      AND (${filter.includeDeleted ?? false} OR deleted_at IS NULL)
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.ownerModuleKey ?? null}::text IS NULL OR owner_module_key = ${filter.ownerModuleKey ?? null})
      AND (${filter.resourceType ?? null}::text IS NULL OR resource_type = ${filter.resourceType ?? null})
      AND (${filter.resourceId ?? null}::text IS NULL OR resource_id = ${filter.resourceId ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as DocumentDbRow[];

  return rows.map(toRow);
}

/**
 * Read surface any OTHER module may call directly (in-process, ADR-0011
 * pattern) to find documents whose PRIMARY resource reference points at
 * one of their own resources — the counterpart to `application/document-
 * resource-relation-port.ts`'s relations-table lookups.
 */
export async function listDocumentsByPrimaryResource(
  tx: Bun.SQL,
  tenantId: string,
  resourceType: string,
  resourceId: string
): Promise<DocumentRow[]> {
  return listDocuments(tx, tenantId, { resourceType, resourceId });
}
