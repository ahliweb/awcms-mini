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
 */
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

/** Bounded list (`LIMIT 200`), newest first — same convention every other `list*` query in this codebase follows. */
export async function listDocumentEvidence(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListEvidenceFilter = {}
): Promise<DocumentEvidenceRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, evidence_type, subject_type, subject_id, document_id,
      sequence_id, reservation_id, actor_tenant_user_id, reason, metadata,
      correlation_id, created_at
    FROM awcms_mini_document_evidence
    WHERE tenant_id = ${tenantId}
      AND (${filter.documentId ?? null}::uuid IS NULL OR document_id = ${filter.documentId ?? null})
      AND (${filter.sequenceId ?? null}::uuid IS NULL OR sequence_id = ${filter.sequenceId ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as DocumentEvidenceDbRow[];

  return rows.map(toRow);
}
