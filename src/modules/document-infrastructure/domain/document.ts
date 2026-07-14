/**
 * Document registry domain rules (Issue #751). Pure functions only.
 *
 * A document's `resourceType`/`resourceId` (its PRIMARY generic resource
 * reference) and `ownerModuleKey` are OPAQUE strings to this module —
 * this module never validates they point at a row that really exists in
 * another module's table (it structurally cannot, ADR-0013 §6 no-shared-
 * table-write) — the CALLING module is responsible for only ever passing
 * an id it has already confirmed belongs to its own tenant-scoped data.
 */
import type { DocumentValidationError } from "./errors";
import {
  CONFIDENTIALITY_LEVELS,
  isConfidentialityLevel,
  isSnakeCaseIdentifier
} from "./errors";

const MAX_TITLE_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_RESOURCE_ID_LENGTH = 200;
const MAX_RETENTION_REFERENCE_LENGTH = 200;

export const DOCUMENT_STATUSES = [
  "active",
  "superseded",
  "archived",
  "void"
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export type CreateDocumentInput = {
  ownerModuleKey: string;
  documentType: string;
  classificationId: string | null;
  title: string;
  summary: string | null;
  issuedAt: Date | null;
  effectiveAt: Date | null;
  confidentialityLevel: string;
  retentionReference: string | null;
  resourceType: string;
  resourceId: string;
};

export function validateCreateDocumentInput(
  input: CreateDocumentInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!isSnakeCaseIdentifier(input.ownerModuleKey)) {
    errors.push({
      field: "ownerModuleKey",
      message: "ownerModuleKey must be a lowercase snake_case module key."
    });
  }
  if (!isSnakeCaseIdentifier(input.documentType)) {
    errors.push({
      field: "documentType",
      message: "documentType must be a lowercase snake_case identifier."
    });
  }
  if (!input.title || input.title.trim().length === 0) {
    errors.push({ field: "title", message: "title is required." });
  } else if (input.title.length > MAX_TITLE_LENGTH) {
    errors.push({
      field: "title",
      message: `title must be at most ${MAX_TITLE_LENGTH} characters.`
    });
  }
  if (input.summary !== null && input.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push({
      field: "summary",
      message: `summary must be at most ${MAX_SUMMARY_LENGTH} characters.`
    });
  }
  if (!isConfidentialityLevel(input.confidentialityLevel)) {
    errors.push({
      field: "confidentialityLevel",
      message: `confidentialityLevel must be one of: ${CONFIDENTIALITY_LEVELS.join(", ")}.`
    });
  }
  if (
    input.retentionReference !== null &&
    input.retentionReference.length > MAX_RETENTION_REFERENCE_LENGTH
  ) {
    errors.push({
      field: "retentionReference",
      message: `retentionReference must be at most ${MAX_RETENTION_REFERENCE_LENGTH} characters.`
    });
  }
  if (!input.resourceType || input.resourceType.trim().length === 0) {
    errors.push({
      field: "resourceType",
      message: "resourceType is required."
    });
  }
  if (!input.resourceId || input.resourceId.trim().length === 0) {
    errors.push({ field: "resourceId", message: "resourceId is required." });
  } else if (input.resourceId.length > MAX_RESOURCE_ID_LENGTH) {
    errors.push({
      field: "resourceId",
      message: `resourceId must be at most ${MAX_RESOURCE_ID_LENGTH} characters.`
    });
  }
  if (input.issuedAt !== null && Number.isNaN(input.issuedAt.getTime())) {
    errors.push({
      field: "issuedAt",
      message: "issuedAt must be a valid date when provided."
    });
  }
  if (input.effectiveAt !== null && Number.isNaN(input.effectiveAt.getTime())) {
    errors.push({
      field: "effectiveAt",
      message: "effectiveAt must be a valid date when provided."
    });
  }

  return errors;
}

export type UpdateDocumentMetadataInput = {
  title: string;
  summary: string | null;
  issuedAt: Date | null;
  effectiveAt: Date | null;
};

export function validateUpdateDocumentMetadataInput(
  input: UpdateDocumentMetadataInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!input.title || input.title.trim().length === 0) {
    errors.push({ field: "title", message: "title is required." });
  } else if (input.title.length > MAX_TITLE_LENGTH) {
    errors.push({
      field: "title",
      message: `title must be at most ${MAX_TITLE_LENGTH} characters.`
    });
  }
  if (input.summary !== null && input.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push({
      field: "summary",
      message: `summary must be at most ${MAX_SUMMARY_LENGTH} characters.`
    });
  }
  if (input.issuedAt !== null && Number.isNaN(input.issuedAt.getTime())) {
    errors.push({
      field: "issuedAt",
      message: "issuedAt must be a valid date when provided."
    });
  }
  if (input.effectiveAt !== null && Number.isNaN(input.effectiveAt.getTime())) {
    errors.push({
      field: "effectiveAt",
      message: "effectiveAt must be a valid date when provided."
    });
  }

  return errors;
}

export type ReclassifyDocumentInput = {
  classificationId: string | null;
  confidentialityLevel: string;
  reason: string;
};

export function validateReclassifyDocumentInput(
  input: ReclassifyDocumentInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!isConfidentialityLevel(input.confidentialityLevel)) {
    errors.push({
      field: "confidentialityLevel",
      message: `confidentialityLevel must be one of: ${CONFIDENTIALITY_LEVELS.join(", ")}.`
    });
  }
  if (!input.reason || input.reason.trim().length === 0) {
    errors.push({ field: "reason", message: "reason is required." });
  }

  return errors;
}

export type VoidDocumentInput = {
  voidReason: string;
};

export function validateVoidDocumentInput(
  input: VoidDocumentInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!input.voidReason || input.voidReason.trim().length === 0) {
    errors.push({ field: "voidReason", message: "voidReason is required." });
  }

  return errors;
}

export type DeleteDocumentInput = {
  deleteReason: string;
};

export function validateDeleteDocumentInput(
  input: DeleteDocumentInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!input.deleteReason || input.deleteReason.trim().length === 0) {
    errors.push({
      field: "deleteReason",
      message: "deleteReason is required."
    });
  }

  return errors;
}

/** A document must be `active` (not already voided/deleted) before it can be voided — voiding an already-void document, or a soft-deleted one, is rejected rather than silently no-op'd. */
export function canVoidDocument(document: {
  status: DocumentStatus;
  deletedAt: Date | null;
}): boolean {
  return document.deletedAt === null && document.status !== "void";
}

/** Only a `void` document (not soft-deleted) can be restored back to `active` through the restore path used for un-voiding; a soft-deleted document is restored through the separate delete/restore pair. */
export function canRestoreVoidedDocument(document: {
  status: DocumentStatus;
  deletedAt: Date | null;
}): boolean {
  return document.deletedAt === null && document.status === "void";
}
