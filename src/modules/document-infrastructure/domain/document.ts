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

/**
 * Confidentiality-tier read permission keys (Issue #751 security-review
 * finding — `confidentiality_level` was stored but never enforced at
 * read time: any caller holding only the base `documents.read`
 * permission could list/fetch `confidential`/`restricted` documents
 * identically to `public` ones). Same "separate, additive read
 * permission gates an extra tier" pattern
 * `visitor_analytics.raw_detail.read` already establishes for this
 * codebase (`sql/038`) — declared here (not re-hardcoded per route
 * file, unlike that precedent) since four route files
 * (`documents/index.ts`, `documents/[id].ts`, `documents/[id]/versions/
 * index.ts`, `documents/[id]/relations/index.ts`) need the identical
 * literal, and duplicating a security-relevant string four times is a
 * real drift risk this module can avoid by centralizing it.
 */
export const CONFIDENTIAL_READ_PERMISSION_KEY =
  "document_infrastructure.documents_confidential.read";
export const RESTRICTED_READ_PERMISSION_KEY =
  "document_infrastructure.documents_restricted.read";

export type ConfidentialityReadAccess = {
  canReadConfidential: boolean;
  canReadRestricted: boolean;
};

/**
 * Pure access decision — the ROUTE HANDLER decides both booleans from
 * whether `auth.grantedPermissionKeys` (already fetched by the single
 * `authorizeInTransaction` call every route already makes for its base
 * guard) contains `CONFIDENTIAL_READ_PERMISSION_KEY`/
 * `RESTRICTED_READ_PERMISSION_KEY`; this function never itself resolves
 * a permission set (same "pure function receives an already-decided
 * boolean, never makes its own authorization decision" convention
 * `visitor-analytics/domain/analytics-response-shaping.ts`'s
 * `shapeVisitorSession` establishes for that module's own tiered-read
 * permission — see that file's header comment). `public`/`internal`
 * are always readable to anyone who already passed the base
 * `documents.read`/`versions.read`/`relations.read` guard.
 */
export function isConfidentialityLevelReadable(
  confidentialityLevel: string,
  access: ConfidentialityReadAccess
): boolean {
  if (confidentialityLevel === "confidential") {
    return access.canReadConfidential;
  }
  if (confidentialityLevel === "restricted") {
    return access.canReadRestricted;
  }
  return true;
}

/**
 * The confidentiality levels a caller with the given clearance may
 * read — used to build the SQL `= ANY(...)` list-query filter in
 * `application/document-directory.ts`'s `listDocuments` (never fetch
 * rows the caller isn't cleared for in the first place, rather than
 * fetch-then-filter in application code).
 */
export function readableConfidentialityLevels(
  access: ConfidentialityReadAccess
): string[] {
  const levels = ["public", "internal"];
  if (access.canReadConfidential) {
    levels.push("confidential");
  }
  if (access.canReadRestricted) {
    levels.push("restricted");
  }
  return levels;
}
