import { describe, expect, test } from "bun:test";

import { resolveMetaTokenReference } from "../../src/modules/social-publishing/infrastructure/meta/meta-token-reference-resolver";

describe("resolveMetaTokenReference (Issue #644)", () => {
  test("resolves an env:VAR_NAME reference to the env var's value", () => {
    const result = resolveMetaTokenReference("env:SOCIAL_TOKEN_FB_PAGE_42", {
      SOCIAL_TOKEN_FB_PAGE_42: "EAAfakeaccesstokenvalue"
    });
    expect(result).toEqual({ value: "EAAfakeaccesstokenvalue" });
  });

  test("null when the referenced env var is unset (fails closed, never throws)", () => {
    expect(resolveMetaTokenReference("env:MISSING_VAR", {})).toBeNull();
  });

  test("null when the referenced env var is empty/whitespace", () => {
    expect(
      resolveMetaTokenReference("env:EMPTY_VAR", { EMPTY_VAR: "   " })
    ).toBeNull();
  });

  test("null for an unsupported reference scheme (no real secret-manager integration in this repo)", () => {
    expect(
      resolveMetaTokenReference("secretsmanager:social/fb-page-42", {
        SOME_VAR: "x"
      })
    ).toBeNull();
    expect(resolveMetaTokenReference("vault:kv/meta", {})).toBeNull();
  });

  test("null for a malformed reference", () => {
    expect(resolveMetaTokenReference("not-a-reference", {})).toBeNull();
    expect(resolveMetaTokenReference("", {})).toBeNull();
  });

  test("never returns the raw reference string itself as the resolved value", () => {
    const reference = "env:SOCIAL_TOKEN_X";
    const result = resolveMetaTokenReference(reference, {
      SOCIAL_TOKEN_X: "the-real-secret-value"
    });
    expect(result?.value).not.toBe(reference);
    expect(result?.value).toBe("the-real-secret-value");
  });
});
