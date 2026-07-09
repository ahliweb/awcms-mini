import { describe, expect, test } from "bun:test";

import { evaluateMfaChallenge } from "../../src/modules/identity-access/domain/mfa-policy";

const NOW = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date(NOW.getTime() + 60_000);
const PAST = new Date(NOW.getTime() - 60_000);

describe("evaluateMfaChallenge", () => {
  test("invalid: not_found when there is no row", () => {
    expect(evaluateMfaChallenge(null, NOW, 5)).toEqual({
      outcome: "invalid",
      reason: "not_found"
    });
  });

  test("invalid: already_used when consumedAt is set", () => {
    const result = evaluateMfaChallenge(
      { expiresAt: FUTURE, consumedAt: PAST, failedAttempts: 0 },
      NOW,
      5
    );
    expect(result).toEqual({ outcome: "invalid", reason: "already_used" });
  });

  test("invalid: too_many_attempts when failedAttempts reaches the max", () => {
    const result = evaluateMfaChallenge(
      { expiresAt: FUTURE, consumedAt: null, failedAttempts: 5 },
      NOW,
      5
    );
    expect(result).toEqual({ outcome: "invalid", reason: "too_many_attempts" });
  });

  test("invalid: expired when expiresAt is in the past", () => {
    const result = evaluateMfaChallenge(
      { expiresAt: PAST, consumedAt: null, failedAttempts: 0 },
      NOW,
      5
    );
    expect(result).toEqual({ outcome: "invalid", reason: "expired" });
  });

  test("valid when none of the deny conditions apply", () => {
    const result = evaluateMfaChallenge(
      { expiresAt: FUTURE, consumedAt: null, failedAttempts: 2 },
      NOW,
      5
    );
    expect(result).toEqual({ outcome: "valid" });
  });

  test("checks failed_attempts and already_used before expiry (deny-reason priority)", () => {
    // A row that is BOTH already used AND expired should report already_used
    // first — matches evaluatePasswordResetToken's own priority ordering.
    const result = evaluateMfaChallenge(
      { expiresAt: PAST, consumedAt: PAST, failedAttempts: 0 },
      NOW,
      5
    );
    expect(result).toEqual({ outcome: "invalid", reason: "already_used" });
  });
});
