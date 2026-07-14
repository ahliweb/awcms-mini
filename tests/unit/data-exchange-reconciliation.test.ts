/**
 * Reconciliation comparison tests (Issue #752 acceptance criterion:
 * "reconciliation can detect a deliberate mismatch").
 */
import { describe, expect, test } from "bun:test";

import { evaluateReconciliation } from "../../src/modules/data-exchange/domain/reconciliation";

describe("evaluateReconciliation", () => {
  test("matching counts and checksums -> no mismatch", () => {
    const verdict = evaluateReconciliation({
      sourceCount: 10,
      processedCount: 10,
      sourceChecksumSha256: "abc123",
      processedChecksumSha256: "abc123"
    });

    expect(verdict.mismatch).toBe(false);
    expect(verdict.countMismatch).toBe(false);
    expect(verdict.checksumMismatch).toBe(false);
  });

  test("a deliberate count mismatch is detected", () => {
    const verdict = evaluateReconciliation({
      sourceCount: 10,
      processedCount: 9,
      sourceChecksumSha256: null,
      processedChecksumSha256: null
    });

    expect(verdict.mismatch).toBe(true);
    expect(verdict.countMismatch).toBe(true);
    expect(verdict.checksumMismatch).toBe(false);
  });

  test("a deliberate checksum mismatch (same count) is detected", () => {
    const verdict = evaluateReconciliation({
      sourceCount: 10,
      processedCount: 10,
      sourceChecksumSha256: "abc123",
      processedChecksumSha256: "def456"
    });

    expect(verdict.mismatch).toBe(true);
    expect(verdict.countMismatch).toBe(false);
    expect(verdict.checksumMismatch).toBe(true);
  });

  test("both count and checksum mismatch simultaneously", () => {
    const verdict = evaluateReconciliation({
      sourceCount: 10,
      processedCount: 8,
      sourceChecksumSha256: "abc123",
      processedChecksumSha256: "def456"
    });

    expect(verdict.mismatch).toBe(true);
    expect(verdict.countMismatch).toBe(true);
    expect(verdict.checksumMismatch).toBe(true);
  });

  test("a missing checksum on either side skips checksum comparison (never treated as a match by default)", () => {
    const verdict = evaluateReconciliation({
      sourceCount: 5,
      processedCount: 5,
      sourceChecksumSha256: null,
      processedChecksumSha256: "def456"
    });

    expect(verdict.checksumMismatch).toBe(false);
    expect(verdict.mismatch).toBe(false);
    expect(verdict.details).toContain("checksum not compared");
  });

  test("details string documents both the count and checksum outcome", () => {
    const verdict = evaluateReconciliation({
      sourceCount: 3,
      processedCount: 3,
      sourceChecksumSha256: "same",
      processedChecksumSha256: "same"
    });

    expect(verdict.details).toContain("source count 3 vs processed count 3");
    expect(verdict.details).toContain("checksum matched");
  });
});
