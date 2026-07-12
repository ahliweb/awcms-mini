import { describe, expect, test } from "bun:test";

import {
  evaluateSocialPublishRateLimitRetry,
  evaluateSocialPublishRetry,
  SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES
} from "../../src/modules/social-publishing/domain/social-publish-retry";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("evaluateSocialPublishRetry (Issue #643)", () => {
  test("not eligible once attemptCount reaches maxAttempts", () => {
    expect(evaluateSocialPublishRetry(5, 5, NOW)).toEqual({ eligible: false });
    expect(evaluateSocialPublishRetry(6, 5, NOW)).toEqual({ eligible: false });
  });

  test("eligible with exponential backoff below maxAttempts", () => {
    const first = evaluateSocialPublishRetry(1, 5, NOW);
    expect(first.eligible).toBe(true);
    if (first.eligible) {
      expect(first.nextAttemptAt.getTime() - NOW.getTime()).toBe(2 * 60_000);
    }

    const second = evaluateSocialPublishRetry(2, 5, NOW);
    expect(second.eligible).toBe(true);
    if (second.eligible) {
      expect(second.nextAttemptAt.getTime() - NOW.getTime()).toBe(4 * 60_000);
    }
  });

  test("caps the delay at SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES", () => {
    const evaluation = evaluateSocialPublishRetry(20, 25, NOW);
    expect(evaluation.eligible).toBe(true);
    if (evaluation.eligible) {
      expect(evaluation.nextAttemptAt.getTime() - NOW.getTime()).toBe(
        SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES * 60_000
      );
    }
  });
});

describe("evaluateSocialPublishRateLimitRetry (Issue #643)", () => {
  test("uses the provider's retryAfterSeconds hint when it exceeds the exponential floor", () => {
    const evaluation = evaluateSocialPublishRateLimitRetry(1, 5, NOW, 600);
    expect(evaluation.eligible).toBe(true);
    if (evaluation.eligible) {
      expect(evaluation.nextAttemptAt.getTime() - NOW.getTime()).toBe(
        600 * 1000
      );
    }
  });

  test("falls back to the exponential floor when retryAfterSeconds is short/absent", () => {
    const withoutHint = evaluateSocialPublishRateLimitRetry(
      1,
      5,
      NOW,
      undefined
    );
    const withShortHint = evaluateSocialPublishRateLimitRetry(1, 5, NOW, 1);
    const exponentialOnly = evaluateSocialPublishRetry(1, 5, NOW);

    expect(withoutHint).toEqual(exponentialOnly);
    expect(withShortHint).toEqual(exponentialOnly);
  });

  test("not eligible once attemptCount reaches maxAttempts, regardless of hint", () => {
    expect(evaluateSocialPublishRateLimitRetry(5, 5, NOW, 9999)).toEqual({
      eligible: false
    });
  });
});
