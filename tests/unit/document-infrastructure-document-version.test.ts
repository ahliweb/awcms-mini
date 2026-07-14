/**
 * Unit tests for document version domain rules (Issue #751) — pure, no
 * I/O.
 */
import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { validateCreateDocumentVersionInput } from "../../src/modules/document-infrastructure/domain/document-version";

// Computed rather than hand-typed to guarantee it is a real, correctly
// formatted 64-character lowercase hex SHA-256 digest.
const VALID_SHA256 = createHash("sha256").update("test-fixture").digest("hex");

const BASE_INPUT = {
  contentReference: "sync-objects/tenant-123/invoice-001.pdf",
  contentReferenceKind: "object_storage_reference",
  mediaType: "application/pdf",
  sizeBytes: 102400,
  checksumSha256: VALID_SHA256,
  source: "upload"
};

describe("validateCreateDocumentVersionInput", () => {
  test("accepts a well-formed input", () => {
    expect(validateCreateDocumentVersionInput(BASE_INPUT)).toEqual([]);
  });

  test("rejects a blank contentReference", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      contentReference: ""
    });
    expect(errors.some((e) => e.field === "contentReference")).toBe(true);
  });

  test("rejects an invalid contentReferenceKind", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      contentReferenceKind: "local_disk"
    });
    expect(errors.some((e) => e.field === "contentReferenceKind")).toBe(true);
  });

  test("rejects a mediaType without a slash", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      mediaType: "pdf"
    });
    expect(errors.some((e) => e.field === "mediaType")).toBe(true);
  });

  test("rejects a negative sizeBytes", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      sizeBytes: -1
    });
    expect(errors.some((e) => e.field === "sizeBytes")).toBe(true);
  });

  test("rejects a non-integer sizeBytes", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      sizeBytes: 1.5
    });
    expect(errors.some((e) => e.field === "sizeBytes")).toBe(true);
  });

  test("rejects a checksum that is not 64 lowercase hex characters", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      checksumSha256: "ABC123"
    });
    expect(errors.some((e) => e.field === "checksumSha256")).toBe(true);
  });

  test("rejects an uppercase-hex checksum (must be lowercase)", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      checksumSha256: VALID_SHA256.toUpperCase()
    });
    expect(errors.some((e) => e.field === "checksumSha256")).toBe(true);
  });

  test("rejects an invalid source", () => {
    const errors = validateCreateDocumentVersionInput({
      ...BASE_INPUT,
      source: "scanned"
    });
    expect(errors.some((e) => e.field === "source")).toBe(true);
  });
});
