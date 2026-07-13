/**
 * Unit tests for pure latency/throughput aggregation (Issue #744, epic
 * #738) — the p50/p95/p99/throughput/error-rate metrics every load
 * scenario reports.
 */
import { describe, expect, test } from "bun:test";

import {
  flattenWorkloadMetrics,
  summarizeLatency,
  summarizeThroughput,
  summarizeWorkload,
  type CallSample
} from "../../src/lib/performance/metrics-aggregate";

describe("summarizeLatency", () => {
  test("returns zeroed summary for an empty sample set", () => {
    const summary = summarizeLatency([]);
    expect(summary.count).toBe(0);
    expect(summary.p50Ms).toBe(0);
    expect(summary.p99Ms).toBe(0);
  });

  test("computes min/max/mean correctly", () => {
    const samples: CallSample[] = [10, 20, 30, 40, 50].map((latencyMs) => ({
      latencyMs,
      ok: true
    }));
    const summary = summarizeLatency(samples);

    expect(summary.count).toBe(5);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(50);
    expect(summary.meanMs).toBe(30);
  });

  test("p99 of a 100-sample uniform set is the largest value (nearest-rank)", () => {
    const samples: CallSample[] = Array.from({ length: 100 }, (_unused, i) => ({
      latencyMs: i + 1,
      ok: true
    }));
    const summary = summarizeLatency(samples);

    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(95);
    expect(summary.p99Ms).toBe(99);
  });

  test("is insensitive to input order", () => {
    const ascending = summarizeLatency(
      [5, 1, 4, 2, 3].map((latencyMs) => ({ latencyMs, ok: true }))
    );
    const shuffled = summarizeLatency(
      [3, 5, 2, 1, 4].map((latencyMs) => ({ latencyMs, ok: true }))
    );

    expect(ascending).toEqual(shuffled);
  });
});

describe("summarizeThroughput", () => {
  test("computes error rate and throughput", () => {
    const samples: CallSample[] = [
      { latencyMs: 1, ok: true },
      { latencyMs: 1, ok: true },
      { latencyMs: 1, ok: false },
      { latencyMs: 1, ok: false }
    ];
    const summary = summarizeThroughput(samples, 2000);

    expect(summary.totalCalls).toBe(4);
    expect(summary.okCalls).toBe(2);
    expect(summary.errorCalls).toBe(2);
    expect(summary.errorRatePercent).toBe(50);
    expect(summary.throughputPerSecond).toBe(2);
  });

  test("returns zero error rate for an empty sample set", () => {
    const summary = summarizeThroughput([], 1000);
    expect(summary.errorRatePercent).toBe(0);
    expect(summary.totalCalls).toBe(0);
  });

  test("floors the divisor at 1ms to avoid divide-by-zero throughput", () => {
    const summary = summarizeThroughput([{ latencyMs: 1, ok: true }], 0);
    expect(Number.isFinite(summary.throughputPerSecond)).toBe(true);
  });
});

describe("summarizeWorkload / flattenWorkloadMetrics", () => {
  test("flattens into a Record<string, number> compatible with ScenarioOutcome.metrics", () => {
    const metrics = summarizeWorkload(
      [
        { latencyMs: 10, ok: true },
        { latencyMs: 20, ok: false }
      ],
      1000
    );
    const flattened = flattenWorkloadMetrics(metrics);

    expect(typeof flattened.p50Ms).toBe("number");
    expect(typeof flattened.errorRatePercent).toBe("number");
    expect(flattened.totalCalls).toBe(2);
    expect(flattened.errorCalls).toBe(1);
  });

  test("applies the given prefix to every key", () => {
    const metrics = summarizeWorkload([{ latencyMs: 5, ok: true }], 1000);
    const flattened = flattenWorkloadMetrics(metrics, "reporting");

    expect(flattened).toHaveProperty("reporting_p50Ms");
    expect(flattened).toHaveProperty("reporting_totalCalls");
    expect(flattened).not.toHaveProperty("p50Ms");
  });
});
