/**
 * Provider-reference masking (Issue #878, epic #868).
 *
 * The rule this pins is "mask by default", and the way a masking helper
 * usually fails is by falling OPEN on the inputs nobody thought about: a short
 * value shown in full because masking it "wouldn't help", a `null` rendered as
 * the literal string `"null"`, a non-string coerced into something readable.
 * Each of those is asserted below, not just the happy path.
 *
 * This test is the reason the logic lives in
 * `payment-gateway/domain/reference-masking.ts` instead of inline in
 * `admin/payment-gateway/index.astro` — code in an `.astro` file is reachable
 * by neither unit tests nor `tsc --noEmit`.
 */
import { describe, expect, test } from "bun:test";
import {
  EMPTY_REFERENCE_PLACEHOLDER,
  maskProviderReference,
  VISIBLE_SUFFIX_LENGTH
} from "../../src/modules/payment-gateway/domain/reference-masking";

describe("maskProviderReference (Issue #878)", () => {
  test("keeps only the last four characters of a real provider reference", () => {
    expect(maskProviderReference("acct_1QWERTYuiop2345")).toBe("••••2345");
    expect(maskProviderReference("cs_live_abcdefghijklmnop")).toBe("••••mnop");
  });

  test("never leaks the leading characters of the reference", () => {
    const reference = "merchant-secret-part-9999";
    const masked = maskProviderReference(reference);

    expect(masked).not.toContain("merchant");
    expect(masked).not.toContain("secret");
    // Only the suffix survives, and nothing longer than the declared window.
    expect(masked.replace(/•/g, "")).toBe(
      reference.slice(-VISIBLE_SUFFIX_LENGTH)
    );
  });

  test("a value too short to mask meaningfully is hidden ENTIRELY, not shown in full", () => {
    // The fail-open shape this exists to prevent: `slice(-4)` on a 3-char
    // value returns the whole value.
    expect(maskProviderReference("abc")).toBe("••••");
    expect(maskProviderReference("abcd")).toBe("••••");
    expect(maskProviderReference("abcde")).toBe("••••bcde");
  });

  test('absent values render as a placeholder, never as "null"/"undefined"', () => {
    expect(maskProviderReference(null)).toBe(EMPTY_REFERENCE_PLACEHOLDER);
    expect(maskProviderReference(undefined)).toBe(EMPTY_REFERENCE_PLACEHOLDER);
    expect(maskProviderReference("")).toBe(EMPTY_REFERENCE_PLACEHOLDER);
  });

  test("a non-string value is masked, not stringified into the page", () => {
    // Row values arrive as `unknown` straight from a JSON response; a number
    // or object must not slip through unmasked.
    expect(maskProviderReference(123456789)).toBe("••••6789");
    expect(maskProviderReference({ ref: "leak-me-1234" })).not.toContain(
      "leak-me"
    );
  });
});
