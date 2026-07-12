/**
 * Issue #698 (epic #679, "operational proof" wave) — proves `runJob`
 * emits `job_run_total`/`job_run_duration_ms`/`job_run_item_count` metrics
 * from its single `buildResult` choke point, for every outcome, without
 * any script/handler needing its own instrumentation.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { acquireAdvisoryLock } from "../../src/lib/jobs/advisory-lock";
import { runJob, type JobDefinition } from "../../src/lib/jobs/job-runner";
import { createInMemoryMetricsPort } from "../../src/lib/observability/in-memory-metrics-port";
import {
  resetMetricsPortForTests,
  setMetricsPort
} from "../../src/lib/observability/metrics-port";

/** Same minimal fake lock `Bun.SQL` as `job-runner.test.ts`. */
function createFakeLockSql(): Bun.SQL {
  const held = new Set<string>();

  function makeReserved() {
    const reservedFn = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const text = strings.join("");
      const lockKey = `${values[0]}:${values[1]}`;

      if (text.includes("pg_try_advisory_lock")) {
        if (held.has(lockKey)) {
          return [{ acquired: false }];
        }
        held.add(lockKey);
        return [{ acquired: true }];
      }

      if (text.includes("pg_advisory_unlock")) {
        held.delete(lockKey);
        return [{ released: true }];
      }

      return [];
    }) as unknown as Bun.SQL;
    (reservedFn as unknown as { release: () => void }).release = () => {};
    return reservedFn;
  }

  return {
    reserve: async () => makeReserved()
  } as unknown as Bun.SQL;
}

function definition(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    name: "test:metrics-job",
    description: "A test job.",
    handler: async () => ({ status: "success" as const }),
    ...overrides
  };
}

describe("runJob metrics (Issue #698)", () => {
  afterEach(() => {
    resetMetricsPortForTests();
  });

  test("a successful run increments job_run_total{status=success} and observes job_run_duration_ms", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    await runJob(definition(), { sql: createFakeLockSql() });

    const snapshot = port.getSnapshot();
    expect(
      snapshot.counters[
        "job_run_total{jobName=test:metrics-job,status=success}"
      ]
    ).toBe(1);
    expect(
      snapshot.histograms["job_run_duration_ms{jobName=test:metrics-job}"]
        ?.count
    ).toBe(1);
  });

  test("itemCounts are mirrored into job_run_item_count gauges, one per named counter", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    await runJob(
      definition({
        handler: async () => ({
          itemCounts: { purged: 120, tenantsChecked: 3 }
        })
      }),
      { sql: createFakeLockSql() }
    );

    const snapshot = port.getSnapshot();
    expect(
      snapshot.gauges[
        "job_run_item_count{itemName=purged,jobName=test:metrics-job}"
      ]
    ).toBe(120);
    expect(
      snapshot.gauges[
        "job_run_item_count{itemName=tenantsChecked,jobName=test:metrics-job}"
      ]
    ).toBe(3);
  });

  test("an unsafe itemCounts key (not a plain code-defined identifier) is silently dropped, never forwarded as a label — security-auditor Medium finding on PR #721", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    const tenantLikeKey = "11111111-1111-1111-1111-111111111111";
    const emailLikeKey = "someone@example.com";
    const taggedKey = "sso-oidc-discovery:tenant-abc:okta";

    await runJob(
      definition({
        handler: async () => ({
          itemCounts: {
            [tenantLikeKey]: 1,
            [emailLikeKey]: 1,
            [taggedKey]: 1,
            purged: 5 // still-safe key, must still come through
          }
        })
      }),
      { sql: createFakeLockSql() }
    );

    const snapshot = port.getSnapshot();
    const gaugeKeys = Object.keys(snapshot.gauges);

    expect(gaugeKeys.some((key) => key.includes(tenantLikeKey))).toBe(false);
    expect(gaugeKeys.some((key) => key.includes(emailLikeKey))).toBe(false);
    expect(gaugeKeys.some((key) => key.includes(taggedKey))).toBe(false);
    expect(
      snapshot.gauges[
        "job_run_item_count{itemName=purged,jobName=test:metrics-job}"
      ]
    ).toBe(5);
  });

  test("a failed run is recorded under status=failed, not success", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    await runJob(
      definition({
        handler: async () => {
          throw new Error("boom");
        }
      }),
      { sql: createFakeLockSql() }
    );

    const snapshot = port.getSnapshot();
    expect(
      snapshot.counters["job_run_total{jobName=test:metrics-job,status=failed}"]
    ).toBe(1);
    expect(
      snapshot.counters[
        "job_run_total{jobName=test:metrics-job,status=success}"
      ]
    ).toBeUndefined();
  });

  test("a skipped run (advisory lock already held) is recorded under status=skipped", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);
    const sql = createFakeLockSql();
    const jobName = "test:metrics-job-skip";

    // Simulate "another instance" by acquiring the lock directly first —
    // same pattern as job-runner.test.ts's own contention test.
    const externalHolder = await acquireAdvisoryLock(sql, jobName);
    expect(externalHolder).not.toBeNull();

    const skipped = await runJob(definition({ name: jobName }), { sql });

    expect(skipped.status).toBe("skipped");

    const snapshot = port.getSnapshot();
    expect(
      snapshot.counters[`job_run_total{jobName=${jobName},status=skipped}`]
    ).toBe(1);
  });
});
