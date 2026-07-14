/**
 * Unit tests for document classification and generic resource-relation
 * domain rules (Issue #751) — pure, no I/O.
 */
import { describe, expect, test } from "bun:test";

import { validateCreateClassificationInput } from "../../src/modules/document-infrastructure/domain/document-classification";
import { validateLinkDocumentToResourceInput } from "../../src/modules/document-infrastructure/domain/document-resource-relation";

describe("validateCreateClassificationInput", () => {
  const BASE = {
    code: "confidential_hr",
    name: "Confidential HR",
    description: null,
    confidentialityLevel: "confidential",
    retentionReference: null
  };

  test("accepts a well-formed classification", () => {
    expect(validateCreateClassificationInput(BASE)).toEqual([]);
  });

  test("rejects a non-snake_case code", () => {
    const errors = validateCreateClassificationInput({
      ...BASE,
      code: "Confidential-HR"
    });
    expect(errors.some((e) => e.field === "code")).toBe(true);
  });

  test("rejects a blank name", () => {
    const errors = validateCreateClassificationInput({ ...BASE, name: "" });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  test("rejects an invalid confidentialityLevel", () => {
    const errors = validateCreateClassificationInput({
      ...BASE,
      confidentialityLevel: "ultra_secret"
    });
    expect(errors.some((e) => e.field === "confidentialityLevel")).toBe(true);
  });
});

describe("validateLinkDocumentToResourceInput", () => {
  const BASE = {
    ownerModuleKey: "profile_identity",
    resourceType: "profile",
    resourceId: "11111111-1111-1111-1111-111111111111",
    relationType: "evidence_for"
  };

  test("accepts a well-formed link", () => {
    expect(validateLinkDocumentToResourceInput(BASE)).toEqual([]);
  });

  test("rejects a non-snake_case ownerModuleKey", () => {
    const errors = validateLinkDocumentToResourceInput({
      ...BASE,
      ownerModuleKey: "Profile-Identity"
    });
    expect(errors.some((e) => e.field === "ownerModuleKey")).toBe(true);
  });

  test("rejects a blank resourceId", () => {
    const errors = validateLinkDocumentToResourceInput({
      ...BASE,
      resourceId: ""
    });
    expect(errors.some((e) => e.field === "resourceId")).toBe(true);
  });

  test("rejects an invalid relationType", () => {
    const errors = validateLinkDocumentToResourceInput({
      ...BASE,
      relationType: "duplicate_of"
    });
    expect(errors.some((e) => e.field === "relationType")).toBe(true);
  });
});
