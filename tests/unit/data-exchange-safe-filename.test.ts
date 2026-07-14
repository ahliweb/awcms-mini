import { describe, expect, test } from "bun:test";

import { sanitizeDisplayFilename } from "../../src/modules/data-exchange/domain/safe-filename";

describe("sanitizeDisplayFilename", () => {
  test("passes through an ordinary filename unchanged", () => {
    expect(sanitizeDisplayFilename("products.csv")).toBe("products.csv");
  });

  test("null stays null", () => {
    expect(sanitizeDisplayFilename(null)).toBeNull();
  });

  test("strips a directory-traversal prefix (unix-style)", () => {
    expect(sanitizeDisplayFilename("../../etc/passwd")).toBe("passwd");
  });

  test("strips a directory-traversal prefix (windows-style)", () => {
    expect(sanitizeDisplayFilename("..\\..\\Windows\\System32\\config")).toBe(
      "config"
    );
  });

  test("strips control characters", () => {
    // Built from code points (never a literal control byte in this source
    // file) -- a NUL (0) and a TAB (9) spliced into an otherwise-normal name.
    const withControlChars =
      "products" + String.fromCharCode(0) + String.fromCharCode(9) + ".csv";
    const result = sanitizeDisplayFilename(withControlChars);
    expect(result).toBe("products.csv");
  });

  test("caps length at 255 characters", () => {
    const longName = `${"a".repeat(400)}.csv`;
    const result = sanitizeDisplayFilename(longName);
    expect(result!.length).toBeLessThanOrEqual(255);
  });

  test("an empty/whitespace-only filename becomes null", () => {
    expect(sanitizeDisplayFilename("   ")).toBeNull();
    expect(sanitizeDisplayFilename("")).toBeNull();
  });

  test("a filename that is ENTIRELY a traversal sequence with trailing slash becomes null", () => {
    expect(sanitizeDisplayFilename("../../../")).toBeNull();
  });
});
