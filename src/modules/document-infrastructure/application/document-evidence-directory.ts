/**
 * Append-only evidence trail (Issue #751 — "Add evidence records for
 * reserved/canceled/replaced/voided versions or numbers"). `recordEvidence`
 * is the ONLY writer of `awcms_mini_document_evidence` — every other
 * application service in this module calls it, in the SAME transaction as
 * the state change it documents, never as a separate/best-effort call.
 * Complements (does not replace) `recordAuditEvent`
 * (`logging/application/audit-log.ts`) — evidence is the domain-level,
 * numbering/version-focused trail; audit is the general high-risk-action
 * log every module already writes to.
 *
 * `listDocumentEvidence`'s `access` parameter (Issue #787 fast-follow) —
 * see that function's own doc comment.
 */
import {
  readableConfidentialityLevels,
  type ConfidentialityReadAccess
} from "../domain/document";

export type DocumentEvidenceType =
  | "number_reserved"
  | "number_committed"
  | "number_canceled"
  | "version_created"
  | "document_voided"
  | "document_restored"
  | "document_reclassified"
  | "sequence_defined"
  | "sequence_revised"
  | "sequence_deactivated"
  | "sequence_restored";

export type DocumentEvidenceSubjectType =
  "document" | "document_version" | "number_reservation" | "number_sequence";

export type DocumentEvidenceRow = {
  id: string;
  tenantId: string;
  evidenceType: DocumentEvidenceType;
  subjectType: DocumentEvidenceSubjectType;
  subjectId: string;
  documentId: string | null;
  sequenceId: string | null;
  reservationId: string | null;
  actorTenantUserId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  correlationId: string | null;
  createdAt: Date;
};

type DocumentEvidenceDbRow = {
  id: string;
  tenant_id: string;
  evidence_type: DocumentEvidenceType;
  subject_type: DocumentEvidenceSubjectType;
  subject_id: string;
  document_id: string | null;
  sequence_id: string | null;
  reservation_id: string | null;
  actor_tenant_user_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  correlation_id: string | null;
  created_at: Date;
};

function toRow(row: DocumentEvidenceDbRow): DocumentEvidenceRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    evidenceType: row.evidence_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    documentId: row.document_id,
    sequenceId: row.sequence_id,
    reservationId: row.reservation_id,
    actorTenantUserId: row.actor_tenant_user_id,
    reason: row.reason,
    metadata: row.metadata,
    correlationId: row.correlation_id,
    createdAt: row.created_at
  };
}

export type RecordEvidenceInput = {
  evidenceType: DocumentEvidenceType;
  subjectType: DocumentEvidenceSubjectType;
  subjectId: string;
  documentId?: string | null;
  sequenceId?: string | null;
  reservationId?: string | null;
  actorTenantUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string;
};

export async function recordDocumentEvidence(
  tx: Bun.SQL,
  tenantId: string,
  input: RecordEvidenceInput
): Promise<DocumentEvidenceRow> {
  const rows = (await tx`
    INSERT INTO awcms_mini_document_evidence
      (tenant_id, evidence_type, subject_type, subject_id, document_id,
       sequence_id, reservation_id, actor_tenant_user_id, reason, metadata,
       correlation_id)
    VALUES (
      ${tenantId}, ${input.evidenceType}, ${input.subjectType}, ${input.subjectId},
      ${input.documentId ?? null}, ${input.sequenceId ?? null}, ${input.reservationId ?? null},
      ${input.actorTenantUserId ?? null}, ${input.reason ?? null}, ${input.metadata ?? {}},
      ${input.correlationId ?? null}
    )
    RETURNING id, tenant_id, evidence_type, subject_type, subject_id, document_id,
      sequence_id, reservation_id, actor_tenant_user_id, reason, metadata,
      correlation_id, created_at
  `) as DocumentEvidenceDbRow[];

  return toRow(rows[0]!);
}

export type ListEvidenceFilter = {
  documentId?: string;
  sequenceId?: string;
};

/**
 * Bounded list (`LIMIT 200`), newest first — same convention every other
 * `list*` query in this codebase follows.
 *
 * `access` is REQUIRED (Issue #787 fast-follow — same discipline
 * `document-directory.ts`'s `listDocuments`/`fetchDocumentById` already
 * enforce). Evidence rows that reference a document
 * (`e.document_id IS NOT NULL` — `document_voided`/`document_restored`/
 * `document_reclassified`/`version_created`/`number_committed`) must not
 * leak that document's existence/history to a caller who lacks
 * confidentiality-tier clearance for it: filtered IN THE QUERY (a `LEFT
 * JOIN` plus `confidentiality_level = ANY(...)`), never fetch-then-
 * filter in application code. Evidence rows with NO document reference
 * (`sequence_defined`/`sequence_revised`/`sequence_deactivated`/
 * `sequence_restored`, and `number_reserved`/`number_canceled` before a
 * reservation is ever committed to a document) have no confidentiality
 * dimension to apply and always pass through — same "public/internal
 * always readable" default `readableConfidentialityLevels` establishes.
 */
export async function listDocumentEvidence(
  tx: Bun.SQL,
  tenantId: string,
  access: ConfidentialityReadAccess,
  filter: ListEvidenceFilter = {}
): Promise<DocumentEvidenceRow[]> {
  const readableLevels = readableConfidentialityLevels(access);

  const rows = (await tx`
    SELECT e.id, e.tenant_id, e.evidence_type, e.subject_type, e.subject_id,
      e.document_id, e.sequence_id, e.reservation_id, e.actor_tenant_user_id,
      e.reason, e.metadata, e.correlation_id, e.created_at
    FROM awcms_mini_document_evidence e
    LEFT JOIN awcms_mini_documents d
      ON d.tenant_id = e.tenant_id AND d.id = e.document_id
    WHERE e.tenant_id = ${tenantId}
      AND (${filter.documentId ?? null}::uuid IS NULL OR e.document_id = ${filter.documentId ?? null})
      AND (${filter.sequenceId ?? null}::uuid IS NULL OR e.sequence_id = ${filter.sequenceId ?? null})
      AND (e.document_id IS NULL OR d.confidentiality_level = ANY(${tx.array(readableLevels, "text")}))
    ORDER BY e.created_at DESC
    LIMIT 200
  `) as DocumentEvidenceDbRow[];

  return rows.map(toRow);
}
