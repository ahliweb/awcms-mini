import { describe, expect, test } from "bun:test";

import {
  hashIdentifier,
  maskIdentifier,
  normalizeIdentifier
} from "../src/modules/profile-identity/domain/identifier";
import { assertMergeRequestIsValid } from "../src/modules/profile-identity/domain/merge";

describe("identifier normalization", () => {
  test("email is trimmed and lowercased", () => {
    expect(normalizeIdentifier("email", "  John.Doe@Example.COM ")).toBe(
      "john.doe@example.com"
    );
  });

  test("phone/whatsapp strip formatting but keep a leading +", () => {
    expect(normalizeIdentifier("phone", "0812-3456-7890")).toBe("081234567890");
    expect(normalizeIdentifier("whatsapp", "+62 812 (3456) 7890")).toBe(
      "+6281234567890"
    );
  });

  test("national_id/tax_id/external_code/other are trimmed only, case preserved", () => {
    expect(normalizeIdentifier("national_id", "  ABC-123  ")).toBe("ABC-123");
    expect(normalizeIdentifier("tax_id", "  Tax-001  ")).toBe("Tax-001");
  });
});

describe("identifier hashing", () => {
  test("is stable, prefixed, and sensitive to the input value", () => {
    const a = hashIdentifier("john.doe@example.com");
    const b = hashIdentifier("john.doe@example.com");
    const c = hashIdentifier("jane.doe@example.com");

    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("identifier masking", () => {
  test("email keeps the first local-part character and the full domain", () => {
    expect(maskIdentifier("email", "john.doe@example.com")).toBe(
      "j*******@example.com"
    );
  });

  test("email with no local part before @ falls back to tail masking", () => {
    expect(maskIdentifier("email", "@example.com")).toBe("********.com");
  });

  test("phone/whatsapp/other keep only the last 4 characters", () => {
    expect(maskIdentifier("phone", "+6281234567890")).toBe("**********7890");
    expect(maskIdentifier("national_id", "ABC")).toBe("***");
  });
});

describe("merge request validation", () => {
  test("rejects a merge request where source equals target", () => {
    expect(() =>
      assertMergeRequestIsValid({
        sourceProfileId: "11111111-1111-1111-1111-111111111111",
        targetProfileId: "11111111-1111-1111-1111-111111111111"
      })
    ).toThrow("must not be the same profile");
  });

  test("accepts a merge request with distinct source and target", () => {
    expect(() =>
      assertMergeRequestIsValid({
        sourceProfileId: "11111111-1111-1111-1111-111111111111",
        targetProfileId: "22222222-2222-2222-2222-222222222222"
      })
    ).not.toThrow();
  });
});
