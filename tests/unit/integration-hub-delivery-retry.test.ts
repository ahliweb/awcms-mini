import { describe, expect, test } from "bun:test";
import { evaluateOutboundDeliveryRetry } from "../../src/modules/integration-hub/domain/delivery-retry";

describe("evaluateOutboundDeliveryRetry", () => {
  const NOW = new Date("2026-07-14T12:00:00.000Z");

  test("eligible with exponential backoff when attempts remain and the failure is retryable", () => {
    const result = evaluateOutboundDeliveryRetry(1, 8, true, NOW);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  test("not eligible once max attempts is reached", () => {
    const result = evaluateOutboundDeliveryRetry(8, 8, true, NOW);
    expect(result.eligible).toBe(false);
  });

  test("not eligible for a non-retryable failure regardless of remaining attempts", () => {
    const result = evaluateOutboundDeliveryRetry(1, 8, false, NOW);
    expect(result.eligible).toBe(false);
  });

  test("delay grows with attempt count, capped at the maximum", () => {
    const early = evaluateOutboundDeliveryRetry(1, 20, true, NOW);
    const later = evaluateOutboundDeliveryRetry(5, 20, true, NOW);
    expect(early.eligible).toBe(true);
    expect(later.eligible).toBe(true);
    if (early.eligible && later.eligible) {
      const earlyDelay = early.nextAttemptAt.getTime() - NOW.getTime();
      const laterDelay = later.nextAttemptAt.getTime() - NOW.getTime();
      expect(laterDelay).toBeGreaterThan(earlyDelay);
    }
  });
});
