/**
 * Load/smoke proof (Issue #698 acceptance criterion: "Load/smoke test
 * proves metrics do not materially degrade request processing").
 *
 * `src/middleware.ts` (where `http_requests_total`/`http_request_duration_ms`
 * are actually recorded per request) cannot be unit-tested directly — it
 * imports the `astro:middleware` virtual module, which only resolves inside
 * Astro's own dev/build pipeline (documented precedent: see
 * `collectRequestAnalytics`'s own doc comment in `src/middleware.ts`, and
 * the Issue #628 investigation it references). This benchmarks the actual
 * per-call cost of the three `recordCounter`/`recordHistogram`/`recordGauge`
 * entry points instead — the exact functions `middleware.ts`,
 * `job-runner.ts`, `circuit-breaker.ts`, and `work-class.ts` call on every
 * request/job-run/provider-call/slot-acquire — under both the default no-op
 * adapter (every deployment that never calls `setMetricsPort`) and a real
 * adapter (`createInMemoryMetricsPort`), proving the label-filtering +
 * error-containment wrapper adds no material overhead either way.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  recordCounter,
  recordGauge,
  recordHistogram,
  resetMetricsPortForTests,
  setMetricsPort
} from "../../src/lib/observability/metrics-port";
import { createInMemoryMetricsPort } from "../../src/lib/observability/in-memory-metrics-port";

const ITERATIONS = 50_000;
// Generous ceiling — this is a smoke test against materially degrading a
// request, not a strict micro-benchmark (avoids flaking on a loaded CI
// runner). 50k calls completing under 1s is >>1000x headroom over any
// single HTTP request's own budget (a handful of calls per request).
const MAX_DURATION_MS = 1000;

describe("metrics recording overhead (Issue #698 load/smoke proof)", () => {
  afterEach(() => {
    resetMetricsPortForTests();
  });

  test(`${ITERATIONS} calls through the no-op default adapter complete well under budget`, () => {
    const startedAt = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      recordCounter("http_requests_total", {
        method: "GET",
        routePattern: "/api/v1/health",
        statusCode: "200"
      });
      recordHistogram("http_request_duration_ms", 12.5, {
        method: "GET",
        routePattern: "/api/v1/health"
      });
      recordGauge("db_pool_work_class_active", 3, { workClass: "interactive" });
    }

    const durationMs = performance.now() - startedAt;
    expect(durationMs).toBeLessThan(MAX_DURATION_MS);
  });

  test(`${ITERATIONS} calls through a real (in-memory) adapter complete well under budget`, () => {
    setMetricsPort(createInMemoryMetricsPort());
    const startedAt = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      recordCounter("http_requests_total", {
        method: "GET",
        routePattern: "/api/v1/health",
        statusCode: "200"
      });
      recordHistogram("http_request_duration_ms", 12.5, {
        method: "GET",
        routePattern: "/api/v1/health"
      });
      recordGauge("db_pool_work_class_active", 3, { workClass: "interactive" });
    }

    const durationMs = performance.now() - startedAt;
    expect(durationMs).toBeLessThan(MAX_DURATION_MS);
  });
});
