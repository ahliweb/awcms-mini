/**
 * Pure metrics aggregation (Issue #744, epic #738 platform-evolution) — no
 * I/O, no database, no `process.*` reads. Scenarios record raw per-call
 * samples (latency + outcome) while they run; this module turns that raw
 * sample list into the summary numbers the issue's acceptance criteria
 * name explicitly: p50/p95/p99 latency, throughput, and error rate.
 * `process-metrics.ts` (a separate, thin I/O module) covers the
 * CPU/memory/pool/queue side, which genuinely does need `process.*` and
 * the work-class gate's live state.
 */

export type CallSample = {
  /** Wall-clock latency of one call, in milliseconds. */
  latencyMs: number;
  /** `true` if the call completed as a genuine success (2xx-equivalent, or a scenario-specific success condition) — a controlled `503 DATABASE_BUSY` counts as `ok: false` here (it IS the error-rate signal saturation scenarios exist to capture), never silently excluded. */
  ok: boolean;
};

export type LatencySummary = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
};

const EMPTY_LATENCY_SUMMARY: LatencySummary = {
  count: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  minMs: 0,
  maxMs: 0,
  meanMs: 0
};

/** Nearest-rank percentile over a SORTED ascending array — deterministic, no interpolation ambiguity between implementations. */
function percentile(sortedLatencies: number[], p: number): number {
  if (sortedLatencies.length === 0) {
    return 0;
  }

  const rank = Math.ceil((p / 100) * sortedLatencies.length);
  const index = Math.min(sortedLatencies.length - 1, Math.max(0, rank - 1));

  return sortedLatencies[index]!;
}

export function summarizeLatency(samples: CallSample[]): LatencySummary {
  if (samples.length === 0) {
    return EMPTY_LATENCY_SUMMARY;
  }

  const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);

  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    meanMs: sum / sorted.length
  };
}

export type ThroughputSummary = {
  totalCalls: number;
  okCalls: number;
  errorCalls: number;
  errorRatePercent: number;
  throughputPerSecond: number;
};

export function summarizeThroughput(
  samples: CallSample[],
  wallClockDurationMs: number
): ThroughputSummary {
  const totalCalls = samples.length;
  const okCalls = samples.filter((s) => s.ok).length;
  const errorCalls = totalCalls - okCalls;
  const seconds = Math.max(wallClockDurationMs, 1) / 1000;

  return {
    totalCalls,
    okCalls,
    errorCalls,
    errorRatePercent: totalCalls === 0 ? 0 : (errorCalls / totalCalls) * 100,
    throughputPerSecond: totalCalls / seconds
  };
}

export type WorkloadMetrics = {
  latency: LatencySummary;
  throughput: ThroughputSummary;
};

export function summarizeWorkload(
  samples: CallSample[],
  wallClockDurationMs: number
): WorkloadMetrics {
  return {
    latency: summarizeLatency(samples),
    throughput: summarizeThroughput(samples, wallClockDurationMs)
  };
}

/** Flattens a `WorkloadMetrics` into the `Record<string, number|string>` shape `ScenarioOutcome.metrics` (resilience `scenario-runner.ts`) expects — so performance scenarios can reuse that exact type without widening it. */
export function flattenWorkloadMetrics(
  metrics: WorkloadMetrics,
  prefix = ""
): Record<string, number> {
  const p = prefix ? `${prefix}_` : "";

  return {
    [`${p}p50Ms`]: round2(metrics.latency.p50Ms),
    [`${p}p95Ms`]: round2(metrics.latency.p95Ms),
    [`${p}p99Ms`]: round2(metrics.latency.p99Ms),
    [`${p}meanMs`]: round2(metrics.latency.meanMs),
    [`${p}maxMs`]: round2(metrics.latency.maxMs),
    [`${p}totalCalls`]: metrics.throughput.totalCalls,
    [`${p}errorCalls`]: metrics.throughput.errorCalls,
    [`${p}errorRatePercent`]: round2(metrics.throughput.errorRatePercent),
    [`${p}throughputPerSecond`]: round2(metrics.throughput.throughputPerSecond)
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
