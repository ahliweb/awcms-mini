/**
 * Drift-fixture tests for `scripts/i18n-parity-check.ts` (Issue #685,
 * epic #679) — proves the gate actually FAILS on each drift shape it
 * claims to catch, using synthetic key sets rather than mutating the real
 * `i18n/*.po`/`.pot` files.
 */
import { describe, expect, test } from "bun:test";

import { checkKeyParity } from "../../scripts/i18n-parity-check";

describe("checkKeyParity", () => {
  test("passes when all catalogs share the exact same key set", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d"]),
      "id.po": new Set(["a.b", "c.d"]),
      "messages.pot": new Set(["a.b", "c.d"])
    });

    expect(problems).toEqual([]);
  });

  test("fails when a key is missing from one catalog (drift fixture)", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d"]),
      "id.po": new Set(["a.b"]), // "c.d" missing — simulates a translator gap
      "messages.pot": new Set(["a.b", "c.d"])
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("i18n/id.po");
    expect(problems[0]!.message).toContain('"c.d"');
  });

  test("fails when a key is missing from the template only (stale .pot)", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d"]),
      "id.po": new Set(["a.b", "c.d"]),
      "messages.pot": new Set(["a.b"]) // "c.d" never extracted to the template
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("i18n/messages.pot");
  });

  test("reports one problem per drifted key, not per catalog", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b", "c.d", "e.f"]),
      "id.po": new Set(["a.b"]),
      "messages.pot": new Set(["a.b"])
    });

    expect(problems).toHaveLength(2);
  });

  test("a key entirely absent from every catalog is not reported (not a parity issue)", () => {
    const problems = checkKeyParity({
      "en.po": new Set(["a.b"]),
      "id.po": new Set(["a.b"]),
      "messages.pot": new Set(["a.b"])
    });

    expect(problems).toEqual([]);
  });

  test("does nothing with fewer than two catalogs (nothing to compare)", () => {
    expect(checkKeyParity({ "en.po": new Set(["a.b"]) })).toEqual([]);
    expect(checkKeyParity({})).toEqual([]);
  });
});
