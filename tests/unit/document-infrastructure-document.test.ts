/**
 * Unit tests for document registry domain rules (Issue #751) — pure, no
 * I/O.
 */
import { describe, expect, test } from "bun:test";

import {
  canRestoreVoidedDocument,
  canVoidDocument,
  validateCreateDocumentInput,
  validateReclassifyDocumentInput,
  validateVoidDocumentInput
} from "../../src/modules/document-infrastructure/domain/document";

const BASE_CREATE_INPUT = {
  ownerModuleKey: "profile_identity",
  documentType: "correspondence",
  classificationId: null,
  title: "Letter of appointment",
  summary: null,
  issuedAt: null,
  effectiveAt: null,
  confidentialityLevel: "internal",
  retentionReference: null,
  resourceType: "profile",
  resourceId: "11111111-1111-1111-1111-111111111111"
};

describe("validateCreateDocumentInput", () => {
  test("accepts a well-formed input", () => {
    expect(validateCreateDocumentInput(BASE_CREATE_INPUT)).toEqual([]);
  });

  test("rejects a non-snake_case ownerModuleKey", () => {
    const errors = validateCreateDocumentInput({
      ...BASE_CREATE_INPUT,
      ownerModuleKey: "ProfileIdentity"
    });
    expect(errors.some((e) => e.field === "ownerModuleKey")).toBe(true);
  });

  test("rejects a blank title", () => {
    const errors = validateCreateDocumentInput({
      ...BASE_CREATE_INPUT,
      title: ""
    });
    expect(errors.some((e) => e.field === "title")).toBe(true);
  });

  test("rejects an invalid confidentialityLevel", () => {
    const errors = validateCreateDocumentInput({
      ...BASE_CREATE_INPUT,
      confidentialityLevel: "top_secret"
    });
    expect(errors.some((e) => e.field === "confidentialityLevel")).toBe(true);
  });

  test("rejects a blank resourceType/resourceId (the primary generic resource reference is required)", () => {
    const errors = validateCreateDocumentInput({
      ...BASE_CREATE_INPUT,
      resourceType: "",
      resourceId: ""
    });
    expect(errors.some((e) => e.field === "resourceType")).toBe(true);
    expect(errors.some((e) => e.field === "resourceId")).toBe(true);
  });
});

describe("validateReclassifyDocumentInput", () => {
  test("requires a non-blank reason", () => {
    const errors = validateReclassifyDocumentInput({
      classificationId: null,
      confidentialityLevel: "confidential",
      reason: ""
    });
    expect(errors.some((e) => e.field === "reason")).toBe(true);
  });
});

describe("validateVoidDocumentInput", () => {
  test("requires a non-blank voidReason", () => {
    expect(
      validateVoidDocumentInput({ voidReason: "" }).some(
        (e) => e.field === "voidReason"
      )
    ).toBe(true);
  });
});

describe("canVoidDocument / canRestoreVoidedDocument", () => {
  test("an active, non-deleted document can be voided", () => {
    expect(canVoidDocument({ status: "active", deletedAt: null })).toBe(true);
  });

  test("an already-void document cannot be voided again", () => {
    expect(canVoidDocument({ status: "void", deletedAt: null })).toBe(false);
  });

  test("a soft-deleted document cannot be voided", () => {
    expect(canVoidDocument({ status: "active", deletedAt: new Date() })).toBe(
      false
    );
  });

  test("a voided, non-deleted document can be un-voided", () => {
    expect(canRestoreVoidedDocument({ status: "void", deletedAt: null })).toBe(
      true
    );
  });

  test("an active document is not eligible for un-void", () => {
    expect(
      canRestoreVoidedDocument({ status: "active", deletedAt: null })
    ).toBe(false);
  });

  test("a soft-deleted voided document is not eligible for un-void (goes through the delete/restore pair instead)", () => {
    expect(
      canRestoreVoidedDocument({ status: "void", deletedAt: new Date() })
    ).toBe(false);
  });
});
