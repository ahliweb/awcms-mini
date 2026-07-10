import { describe, expect, test } from "bun:test";

import {
  ANALYTICS_RANGES,
  isKnownAnalyticsRange,
  resolveRangeStart
} from "../../src/modules/visitor-analytics/domain/analytics-range";

describe("isKnownAnalyticsRange", () => {
  test("accepts the four known ranges", () => {
    for (const range of ANALYTICS_RANGES) {
      expect(isKnownAnalyticsRange(range)).toBe(true);
    }
  });

  test("rejects unknown/undefined/null values", () => {
    expect(isKnownAnalyticsRange("1h")).toBe(false);
    expect(isKnownAnalyticsRange(undefined)).toBe(false);
    expect(isKnownAnalyticsRange(null)).toBe(false);
    expect(isKnownAnalyticsRange("")).toBe(false);
  });
});

describe("resolveRangeStart", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  test("24h subtracts 24 hours", () => {
    expect(resolveRangeStart("24h", now).toISOString()).toBe(
      "2026-07-09T12:00:00.000Z"
    );
  });

  test("7d subtracts 7 days", () => {
    expect(resolveRangeStart("7d", now).toISOString()).toBe(
      "2026-07-03T12:00:00.000Z"
    );
  });

  test("30d subtracts 30 days", () => {
    expect(resolveRangeStart("30d", now).toISOString()).toBe(
      "2026-06-10T12:00:00.000Z"
    );
  });

  test("12m subtracts 12 months", () => {
    expect(resolveRangeStart("12m", now).toISOString()).toBe(
      "2025-07-10T12:00:00.000Z"
    );
  });

  test("never mutates the input date", () => {
    const original = new Date(now);
    resolveRangeStart("7d", now);
    expect(now.toISOString()).toBe(original.toISOString());
  });
});
