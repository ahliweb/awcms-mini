/**
 * Document version domain rules (Issue #751). Pure functions only.
 *
 * Versions are IMMUTABLE/append-only — see `sql/066`'s own header and
 * `application/document-version-service.ts`'s header for where that is
 * actually enforced (structurally: no UPDATE/DELETE statement against
 * `awcms_mini_document_versions` exists anywhere in this module).
 * `contentReference` points at an approved managed-object storage
 * contract (e.g. a `sync_storage` object key, or an external URL/system
 * reference) — this module never receives or stores the actual bytes.
 */
import type { DocumentValidationError } from "./errors";

const MAX_CONTENT_REFERENCE_LENGTH = 1000;
const MAX_MEDIA_TYPE_LENGTH = 200;
const MAX_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB ceiling — a sanity bound, not a real upload limit (this module never receives bytes).
const CHECKSUM_SHA256_LENGTH = 64;

export const CONTENT_REFERENCE_KINDS = [
  "object_storage_reference",
  "external_url",
  "external_system_reference"
] as const;
export type ContentReferenceKind = (typeof CONTENT_REFERENCE_KINDS)[number];

export const VERSION_SOURCES = [
  "upload",
  "import",
  "generated",
  "migrated"
] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

function isHexSha256(value: string): boolean {
  if (value.length !== CHECKSUM_SHA256_LENGTH) return false;
  for (const ch of value) {
    const isDigit = ch >= "0" && ch <= "9";
    const isLowerHex = ch >= "a" && ch <= "f";
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

export type CreateDocumentVersionInput = {
  contentReference: string;
  contentReferenceKind: string;
  mediaType: string;
  sizeBytes: number;
  checksumSha256: string;
  source: string;
};

export function validateCreateDocumentVersionInput(
  input: CreateDocumentVersionInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!input.contentReference || input.contentReference.trim().length === 0) {
    errors.push({
      field: "contentReference",
      message: "contentReference is required."
    });
  } else if (input.contentReference.length > MAX_CONTENT_REFERENCE_LENGTH) {
    errors.push({
      field: "contentReference",
      message: `contentReference must be at most ${MAX_CONTENT_REFERENCE_LENGTH} characters.`
    });
  }

  if (
    !(CONTENT_REFERENCE_KINDS as readonly string[]).includes(
      input.contentReferenceKind
    )
  ) {
    errors.push({
      field: "contentReferenceKind",
      message: `contentReferenceKind must be one of: ${CONTENT_REFERENCE_KINDS.join(", ")}.`
    });
  }

  if (!input.mediaType || input.mediaType.trim().length === 0) {
    errors.push({ field: "mediaType", message: "mediaType is required." });
  } else if (input.mediaType.length > MAX_MEDIA_TYPE_LENGTH) {
    errors.push({
      field: "mediaType",
      message: `mediaType must be at most ${MAX_MEDIA_TYPE_LENGTH} characters.`
    });
  } else if (!input.mediaType.includes("/")) {
    errors.push({
      field: "mediaType",
      message: 'mediaType must look like a MIME type (e.g. "application/pdf").'
    });
  }

  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    errors.push({
      field: "sizeBytes",
      message: "sizeBytes must be a non-negative integer."
    });
  } else if (input.sizeBytes > MAX_SIZE_BYTES) {
    errors.push({
      field: "sizeBytes",
      message: `sizeBytes must be at most ${MAX_SIZE_BYTES} bytes.`
    });
  }

  if (!isHexSha256(input.checksumSha256)) {
    errors.push({
      field: "checksumSha256",
      message:
        "checksumSha256 must be a 64-character lowercase hex SHA-256 digest."
    });
  }

  if (!(VERSION_SOURCES as readonly string[]).includes(input.source)) {
    errors.push({
      field: "source",
      message: `source must be one of: ${VERSION_SOURCES.join(", ")}.`
    });
  }

  return errors;
}
