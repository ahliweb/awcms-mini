import { describe, expect, test } from "bun:test";

import { createPrometheusTextMetricsPort } from "../../src/lib/observability/adapters/prometheus-text-adapter";

describe("createPrometheusTextMetricsPort (Issue #698 — representative adapter)", () => {
  test("renders counters with HELP/TYPE and label pairs", () => {
    const port = createPrometheusTextMetricsPort();

    port.incrementCounter(
      "job_run_total",
      { jobName: "logs-audit-purge", status: "success" },
      3
    );

    const text = port.renderPrometheusText();

    expect(text).toContain("# HELP job_run_total");
    expect(text).toContain("# TYPE job_run_total counter");
    expect(text).toContain(
      'job_run_total{jobName="logs-audit-purge",status="success"} 3'
    );
  });

  test("renders gauges", () => {
    const port = createPrometheusTextMetricsPort();

    port.setGauge("db_pool_work_class_active", 4, { workClass: "interactive" });

    const text = port.renderPrometheusText();

    expect(text).toContain("# TYPE db_pool_work_class_active gauge");
    expect(text).toContain(
      'db_pool_work_class_active{workClass="interactive"} 4'
    );
  });

  test("renders a histogram with cumulative buckets, +Inf, sum, and count", () => {
    const port = createPrometheusTextMetricsPort([10, 50, 100]);

    port.observeHistogram("job_run_duration_ms", 5, { jobName: "a" });
    port.observeHistogram("job_run_duration_ms", 40, { jobName: "a" });
    port.observeHistogram("job_run_duration_ms", 500, { jobName: "a" });

    const text = port.renderPrometheusText();

    // 5ms falls into every bucket >= 10; 40ms into buckets >= 50; 500ms into none.
    expect(text).toContain('job_run_duration_ms_bucket{jobName="a",le="10"} 1');
    expect(text).toContain('job_run_duration_ms_bucket{jobName="a",le="50"} 2');
    expect(text).toContain(
      'job_run_duration_ms_bucket{jobName="a",le="100"} 2'
    );
    expect(text).toContain(
      'job_run_duration_ms_bucket{jobName="a",le="+Inf"} 3'
    );
    expect(text).toContain('job_run_duration_ms_sum{jobName="a"} 545');
    expect(text).toContain('job_run_duration_ms_count{jobName="a"} 3');
  });

  test("reset() clears every series from the rendered output", () => {
    const port = createPrometheusTextMetricsPort();

    port.incrementCounter(
      "job_run_total",
      { jobName: "a", status: "success" },
      1
    );
    port.reset();

    expect(port.renderPrometheusText()).toBe("");
  });

  test("empty adapter renders an empty string", () => {
    const port = createPrometheusTextMetricsPort();

    expect(port.renderPrometheusText()).toBe("");
  });
});
