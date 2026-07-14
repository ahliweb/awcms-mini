/**
 * Document version service (Issue #751) — the ONLY function in this
 * module that INSERTs into `awcms_mini_document_versions`. There is no
 * UPDATE or DELETE statement against that table ANYWHERE in this module
 * (grep it: `grep -rn "document_versions" src/modules/document-
 * infrastructure` shows every hit is either this INSERT, a read-only
 * SELECT, or a documentation comment) — corrections are a NEW row with
 * `previous_version_id` pointing backward, never an edit of an existing
 * row. This is the "trace backward from the real write path" proof the
 * issue's own critical warning #4 demands, not just a doc-comment claim.
 *
 * `awcms_mini_documents.current_version_number` is a denormalized cache,
 * updated in the SAME transaction as the version insert, still never
 * touching the version row itself.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
  DOCUMENT_INFRASTRUCTURE_VERSION_CREATED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { recordDocumentEvidence } from "./document-evidence-directory";
import {
  validateCreateDocumentVersionInput,
  type CreateDocumentVersionInput
} from "../domain/document-version";
import {
  isConfidentialityLevelReadable,
  type ConfidentialityReadAccess
} from "../domain/document";
import type { DocumentValidationError } from "../domain/errors";

const MODULE_KEY = "document_infrastructure";

export type DocumentVersionRow = {
  id: string;
  tenantId: string;
  documentId: string;
  versionNumber: number;
  contentReference: string;
  contentReferenceKind: string;
  mediaType: string;
  sizeBytes: number;
  checksumSha256: string;
  source: string;
  previousVersionId: string | null;
  createdByTenantUserId: string | null;
  correlationId: string | null;
  createdAt: Date;
};

type DocumentVersionDbRow = {
  id: string;
  tenant_id: string;
  document_id: string;
  version_number: number;
  content_reference: string;
  content_reference_kind: string;
  media_type: string;
  size_bytes: number | string;
  checksum_sha256: string;
  source: string;
  previous_version_id: string | null;
  created_by_tenant_user_id: string | null;
  correlation_id: string | null;
  created_at: Date;
};

function toRow(row: DocumentVersionDbRow): DocumentVersionRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    contentReference: row.content_reference,
    contentReferenceKind: row.content_reference_kind,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    source: row.source,
    previousVersionId: row.previous_version_id,
    createdByTenantUserId: row.created_by_tenant_user_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at
  };
}

export type CreateDocumentVersionResult =
  | { ok: true; version: DocumentVersionRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "document_not_found" };

/**
 * `access` is REQUIRED (Issue #787 fast-follow) — a caller holding only
 * the base `versions.create` action permission must not be able to
 * append a new version to a `confidential`/`restricted` document they
 * lack read clearance for (this would let them confirm the parent
 * document's existence, and attach new content to a document whose
 * existing content they cannot themselves see). Returns
 * `document_not_found` (identical to genuinely-not-found/soft-deleted),
 * same anti-enumeration reasoning the read paths use.
 */
export async function createDocumentVersion(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  input: CreateDocumentVersionInput,
  access: ConfidentialityReadAccess,
  correlationId?: string
): Promise<CreateDocumentVersionResult> {
  const errors = validateCreateDocumentVersionInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  // Lock the parent document row for the duration of this transaction —
  // two concurrent "create version" calls for the SAME document must not
  // both compute the same `nextVersionNumber` (the same class of race
  // `organization-unit-hierarchy-service.ts` documents for its own
  // "read current state, then write" shape). `FOR UPDATE` here plus the
  // UNIQUE (tenant_id, document_id, version_number) index (sql/066) is
  // belt-and-suspenders: even if the lock were somehow bypassed, the
  // unique index would reject a duplicate version_number outright.
  const documentRows = (await tx`
    SELECT id, current_version_number, deleted_at, confidentiality_level
    FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
    FOR UPDATE
  `) as {
    id: string;
    current_version_number: number;
    deleted_at: Date | null;
    confidentiality_level: string;
  }[];

  const document = documentRows[0];
  if (!document || document.deleted_at !== null) {
    return { ok: false, reason: "document_not_found" };
  }
  if (!isConfidentialityLevelReadable(document.confidentiality_level, access)) {
    return { ok: false, reason: "document_not_found" };
  }

  const previousVersionRows = (await tx`
    SELECT id FROM awcms_mini_document_versions
    WHERE tenant_id = ${tenantId} AND document_id = ${documentId}
      AND version_number = ${document.current_version_number}
  `) as { id: string }[];
  const previousVersionId = previousVersionRows[0]?.id ?? null;

  const nextVersionNumber = document.current_version_number + 1;

  const insertedRows = (await tx`
    INSERT INTO awcms_mini_document_versions
      (tenant_id, document_id, version_number, content_reference,
       content_reference_kind, media_type, size_bytes, checksum_sha256,
       source, previous_version_id, created_by_tenant_user_id, correlation_id)
    VALUES (
      ${tenantId}, ${documentId}, ${nextVersionNumber}, ${input.contentReference},
      ${input.contentReferenceKind}, ${input.mediaType}, ${input.sizeBytes},
      ${input.checksumSha256}, ${input.source}, ${previousVersionId},
      ${actorTenantUserId}, ${correlationId ?? null}
    )
    RETURNING id, tenant_id, document_id, version_number, content_reference,
      content_reference_kind, media_type, size_bytes, checksum_sha256, source,
      previous_version_id, created_by_tenant_user_id, correlation_id, created_at
  `) as DocumentVersionDbRow[];

  const version = toRow(insertedRows[0]!);

  await tx`
    UPDATE awcms_mini_documents
    SET current_version_number = ${nextVersionNumber}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_VERSION_CREATED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "document_version",
    aggregateId: version.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      documentId,
      versionNumber: version.versionNumber,
      mediaType: version.mediaType,
      sizeBytes: version.sizeBytes,
      checksumSha256: version.checksumSha256
    }
  });

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "version_created",
    subjectType: "document_version",
    subjectId: version.id,
    documentId,
    actorTenantUserId,
    metadata: { versionNumber: version.versionNumber, previousVersionId },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "document_version",
    resourceId: version.id,
    severity: "info",
    message: `Document version ${version.versionNumber} created for document ${documentId}.`,
    attributes: { documentId, versionNumber: version.versionNumber },
    correlationId
  });

  return { ok: true, version };
}

/** Bounded list (`LIMIT 200`), newest (highest version_number) first. Read-only — never a mutation. */
export async function listDocumentVersions(
  tx: Bun.SQL,
  tenantId: string,
  documentId: string
): Promise<DocumentVersionRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, document_id, version_number, content_reference,
      content_reference_kind, media_type, size_bytes, checksum_sha256, source,
      previous_version_id, created_by_tenant_user_id, correlation_id, created_at
    FROM awcms_mini_document_versions
    WHERE tenant_id = ${tenantId} AND document_id = ${documentId}
    ORDER BY version_number DESC
    LIMIT 200
  `) as DocumentVersionDbRow[];

  return rows.map(toRow);
}
