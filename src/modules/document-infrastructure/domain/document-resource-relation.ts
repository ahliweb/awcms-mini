/**
 * Generic document<->resource relation domain rules (Issue #751). Pure
 * functions only. `ownerModuleKey`/`resourceType`/`resourceId` are opaque
 * strings supplied by the CALLING module through the capability port
 * (`application/document-resource-relation-port.ts`) — never validated
 * against a foreign table this module cannot see (ADR-0013 §6).
 */
import type { DocumentValidationError } from "./errors";
import { isSnakeCaseIdentifier } from "./errors";

const MAX_RESOURCE_ID_LENGTH = 200;

export const RELATION_TYPES = [
  "evidence_for",
  "attachment_of",
  "reference_of",
  "related_to",
  "supersedes"
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export type LinkDocumentToResourceInput = {
  ownerModuleKey: string;
  resourceType: string;
  resourceId: string;
  relationType: string;
};

export function validateLinkDocumentToResourceInput(
  input: LinkDocumentToResourceInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!isSnakeCaseIdentifier(input.ownerModuleKey)) {
    errors.push({
      field: "ownerModuleKey",
      message: "ownerModuleKey must be a lowercase snake_case module key."
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
  if (!(RELATION_TYPES as readonly string[]).includes(input.relationType)) {
    errors.push({
      field: "relationType",
      message: `relationType must be one of: ${RELATION_TYPES.join(", ")}.`
    });
  }

  return errors;
}
