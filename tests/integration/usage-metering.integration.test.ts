/**
 * Integration tests for `usage_metering` against real PostgreSQL (Issue #875,
 * epic #868, ADR-0022). Covers: idempotent append (a duplicate producer event
 * counted once), tenant-scoped RLS isolation, the aggregation worker
 * (deterministic materialization + idempotent re-run + rebuild reproduces),
 * corrections (reversal negates + original evidence preserved), reconciliation
 * (a lost late event turns the run red — the mutation guard), append-only
 * immutability triggers + least-privilege role grants, and the fail-closed quota
 * decision through the aggregate port.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { listModules } from "../../src/modules";
import { createUsageAppendPort } from "../../src/modules/usage-metering/application/usage-append-adapter";
import { buildContractRegistry } from "../../src/modules/usage-metering/application/meter-registry";
import { createUsageAggregatePort } from "../../src/modules/usage-metering/application/usage-aggregate-adapter";
import { createEffectiveEntitlementPort } from "../../src/modules/tenant-entitlement/application/effective-entitlement-port-adapter";
import { createServiceCatalogReadPort } from "../../src/modules/service-catalog/application/service-catalog-read-port-adapter";
import { aggregateTenant } from "../../src/modules/usage-metering/application/aggregation-engine";
import {
  applyCorrection,
  listCorrections
} from "../../src/modules/usage-metering/application/correction-directory";
import { runReconciliation } from "../../src/modules/usage-metering/application/reconciliation";
import {
  listAggregates,
  listUsageEvents
} from "../../src/modules/usage-metering/application/usage-read-query";
import { requestAggregateRebuild } from "../../src/modules/usage-metering/application/rebuild-directory";
import {
  computeBoundedQuotaUsage,
  subWindowTypeFor
} from "../../src/modules/usage-metering/application/quota-usage-recompute";
import { readWindowSources } from "../../src/modules/usage-metering/application/usage-source-query";
import {
  computeWindowAggregate,
  windowBoundsFor
} from "../../src/modules/usage-metering/domain/meter-semantics";
import { resolveMeter } from "../../src/modules/usage-metering/application/meter-registry";
import type { EffectiveEntitlementPort } from "../../src/modules/_shared/ports/effective-entitlement-port";

const registry = buildContractRegistry(listModules());
const ACTOR = "00000000-0000-0000-0000-0000000000aa";
const METER = "usage_metering.sample_actions"; // sum + signed_delta
const MAX_METER = "usage_metering.sample_peak"; // max
const LAST_METER = "usage_metering.sample_level"; // last
const UNIQUE_METER = "usage_metering.sample_actors"; // unique_count
const appendPort = createUsageAppendPort(registry);

async function seedTenant(prefix: string): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name, status)
    VALUES (${prefix + Math.random().toString(36).slice(2, 8)}, 'Usage Test', 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function append(
  tenantId: string,
  sourceEventId: string,
  quantity: number,
  eventTime: string
) {
  const sql = getTestSql();
  return withTenant(sql, tenantId, (tx) =>
    appendPort(tx, tenantId, {
      meterKey: METER,
      producer: "billing",
      sourceEventId,
      quantity,
      eventTime
    })
  );
}

async function aggregate(tenantId: string, now?: Date) {
  const worker = getWorkerTestSql();
  return withTenant(
    worker,
    tenantId,
    (tx) =>
      aggregateTenant(tx, tenantId, registry, {
        leaseHolder: "test-worker",
        now
      }),
    { workClass: "maintenance" }
  );
}

/** Append to any meter (optional `uniqueDimension` for unique_count meters). */
async function appendMeter(
  tenantId: string,
  meterKey: string,
  sourceEventId: string,
  quantity: number,
  eventTime: string,
  uniqueDimension?: string
) {
  const sql = getTestSql();
  return withTenant(sql, tenantId, (tx) =>
    appendPort(tx, tenantId, {
      meterKey,
      producer: "billing",
      sourceEventId,
      quantity,
      eventTime,
      uniqueDimension
    })
  );
}

/** The Issue #901 BOUNDED recompute (settled sub-aggregates + live open tail). */
async function boundedUsed(
  tenantId: string,
  meterKey: string,
  start: Date,
  end: Date,
  now: Date,
  opts?: { maxSourceRows?: number }
): Promise<number> {
  return withTenant(getTestSql(), tenantId, (tx) => {
    const meter = resolveMeter(registry, meterKey)!;
    return computeBoundedQuotaUsage(
      tx,
      tenantId,
      meterKey,
      meter.aggregation,
      meter.valueType,
      "month",
      start,
      end,
      now,
      opts
    );
  });
}

/** The OLD unbounded full-window recompute — the equivalence oracle. */
async function fullRecomputeUsed(
  tenantId: string,
  meterKey: string,
  start: Date,
  end: Date
): Promise<number> {
  return withTenant(getTestSql(), tenantId, async (tx) => {
    const meter = resolveMeter(registry, meterKey)!;
    const src = await readWindowSources(
      tx,
      tenantId,
      meterKey,
      start,
      end,
      null
    );
    return computeWindowAggregate(
      meter.aggregation,
      meter.valueType,
      src.events,
      src.corrections
    ).value;
  });
}

async function windowValue(
  tenantId: string,
  windowType: "hour" | "day" | "month"
): Promise<number | null> {
  const sql = getTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await listAggregates(
      tx,
      tenantId,
      METER,
      windowType,
      new Date()
    );
    return rows[0] ? rows[0].value : null;
  });
}

/**
 * Discriminative audit lookup (memory audit-count-assertion-vacuous): match on
 * BOTH `action` AND `resource_type` (the diskriminator) so a generic `action`
 * name alone can never make the assertion vacuous, and return each row's
 * `resource_id` so a test can tie it to the exact entity.
 */
async function auditResourceIds(
  tenantId: string,
  action: string,
  resourceType: string
): Promise<string[]> {
  return withTenant(getTestSql(), tenantId, async (tx) => {
    const rows = (await tx`
      SELECT resource_id FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId} AND module_key = 'usage_metering'
        AND action = ${action} AND resource_type = ${resourceType}
    `) as { resource_id: string | null }[];
    return rows.map((r) => r.resource_id ?? "");
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("usage_metering — integration", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  test("append is idempotent — a duplicate producer event is counted once", async () => {
    const tenantId = await seedTenant("um");
    const first = await append(tenantId, "evt-1", 5, "2026-07-19T10:10:00Z");
    const second = await append(tenantId, "evt-1", 5, "2026-07-19T10:10:00Z");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.eventId).toBe(first.eventId);
    }
    const events = await withTenant(getTestSql(), tenantId, (tx) =>
      listUsageEvents(tx, tenantId, METER)
    );
    expect(events).toHaveLength(1);
  });

  test("tenant-scoped RLS isolates usage between tenants", async () => {
    const a = await seedTenant("uma");
    const b = await seedTenant("umb");
    await append(a, "evt-a", 3, "2026-07-19T10:10:00Z");
    const bEvents = await withTenant(getTestSql(), b, (tx) =>
      listUsageEvents(tx, b, METER)
    );
    expect(bEvents).toHaveLength(0);
  });

  test("the aggregation worker materializes the sum window; a re-run is idempotent (no double count)", async () => {
    const tenantId = await seedTenant("umagg");
    await append(tenantId, "e1", 2, "2026-07-19T10:10:00Z");
    await append(tenantId, "e2", 3, "2026-07-19T10:20:00Z");
    await append(tenantId, "e3", 5, "2026-07-19T10:30:00Z");

    const r1 = await aggregate(tenantId);
    expect(r1.skipped).toBe(false);
    expect(await windowValue(tenantId, "hour")).toBe(10);

    // Re-run: recompute-from-source is idempotent — the value must not double.
    const r2 = await aggregate(tenantId);
    expect(r2.processed).toBe(0);
    expect(await windowValue(tenantId, "hour")).toBe(10);
  });

  test("reconciliation MUTATION GUARD: a late event not yet aggregated turns the run red; a rebuild repairs it", async () => {
    const tenantId = await seedTenant("umrec");
    await append(tenantId, "e1", 4, "2026-07-19T10:10:00Z");
    await append(tenantId, "e2", 6, "2026-07-19T10:20:00Z");
    await aggregate(tenantId);
    expect(await windowValue(tenantId, "hour")).toBe(10);

    // A LATE event lands in the same (already-materialized) hour window but is
    // NOT re-aggregated yet: the stored aggregate now understates the truth.
    await append(tenantId, "e3-late", 7, "2026-07-19T10:05:00Z");

    const drift = await withTenant(getTestSql(), tenantId, (tx) =>
      runReconciliation(tx, tenantId, ACTOR, registry, {
        meterKey: METER,
        windowType: "hour",
        rangeFrom: new Date("2026-07-19T00:00:00Z"),
        rangeTo: new Date("2026-07-20T00:00:00Z")
      })
    );
    expect(drift.ok).toBe(true);
    if (drift.ok) {
      // If aggregation had duplicate-counted or the recompute had dropped the
      // late event, these would be `consistent` / 0 — the guard would not fire.
      expect(drift.run.status).toBe("drift_detected");
      expect(drift.run.driftCount).toBeGreaterThanOrEqual(1);
    }

    // A rebuild recomputes every window from source -> reconciliation clean.
    await withTenant(getTestSql(), tenantId, (tx) =>
      requestAggregateRebuild(tx, tenantId, ACTOR)
    );
    await aggregate(tenantId);
    expect(await windowValue(tenantId, "hour")).toBe(17);

    const clean = await withTenant(getTestSql(), tenantId, (tx) =>
      runReconciliation(tx, tenantId, ACTOR, registry, {
        meterKey: METER,
        windowType: "hour",
        rangeFrom: new Date("2026-07-19T00:00:00Z"),
        rangeTo: new Date("2026-07-20T00:00:00Z")
      })
    );
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.run.status).toBe("consistent");

    // Discriminative audit assertion: each runReconciliation writes a
    // `reconcile` / `usage_reconciliation_run` audit row tied to the run id.
    const reconcileAuditIds = await auditResourceIds(
      tenantId,
      "reconcile",
      "usage_reconciliation_run"
    );
    expect(reconcileAuditIds.length).toBe(2); // the drift run + the clean run
    if (clean.ok) expect(reconcileAuditIds).toContain(clean.run.id);
    // The diskriminator matters: no reconcile row is misfiled under a correction.
    expect(
      await auditResourceIds(tenantId, "correct", "usage_reconciliation_run")
    ).toEqual([]);
  });

  test("a reversal correction negates the original's contribution after re-aggregation; original evidence is preserved", async () => {
    const tenantId = await seedTenant("umcorr");
    const appended = await append(tenantId, "e1", 10, "2026-07-19T10:10:00Z");
    expect(appended.ok).toBe(true);
    const originalEventId = appended.ok ? appended.eventId : "";
    await aggregate(tenantId);
    expect(await windowValue(tenantId, "hour")).toBe(10);

    const result = await withTenant(getTestSql(), tenantId, (tx) =>
      applyCorrection(tx, tenantId, ACTOR, registry, {
        originalEventId,
        correctionType: "reversal",
        deltaQuantity: null,
        reason: "duplicate charge",
        producer: "billing",
        sourceEventId: "corr-1",
        sourceVersion: 1
      })
    );
    expect(result.ok).toBe(true);
    const correctionId = result.ok ? result.correction.id : "";
    if (result.ok) expect(result.correction.deltaQuantity).toBe(-10);

    // Discriminative audit assertion: applyCorrection writes a `correct` /
    // `usage_correction` audit row tied to the correction id (not vacuous:
    // both action AND resource_type must match, and the id ties to the entity).
    const correctAuditIds = await auditResourceIds(
      tenantId,
      "correct",
      "usage_correction"
    );
    expect(correctAuditIds).toEqual([correctionId]);
    // The diskriminator matters: no correction row is misfiled under a run type.
    expect(
      await auditResourceIds(tenantId, "reconcile", "usage_correction")
    ).toEqual([]);

    await aggregate(tenantId);
    expect(await windowValue(tenantId, "hour")).toBe(0);

    // The correction is recorded and the ORIGINAL immutable event survives.
    const corrections = await withTenant(getTestSql(), tenantId, (tx) =>
      listCorrections(tx, tenantId, METER)
    );
    expect(corrections).toHaveLength(1);
    const events = await withTenant(getTestSql(), tenantId, (tx) =>
      listUsageEvents(tx, tenantId, METER)
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.quantity).toBe(10);
  });

  test("immutability + least privilege: the app role cannot edit an event or write an aggregate; the trigger blocks an in-place edit", async () => {
    const tenantId = await seedTenant("umimm");
    const appended = await append(tenantId, "e1", 4, "2026-07-19T10:10:00Z");
    const eventId = appended.ok ? appended.eventId : "";

    // App role is REVOKE'd UPDATE/DELETE on events (least privilege).
    let appUpdateThrew = false;
    try {
      await withTenant(
        getTestSql(),
        tenantId,
        (tx) =>
          tx`UPDATE awcms_mini_usage_events SET quantity = 0 WHERE id = ${eventId}`
      );
    } catch {
      appUpdateThrew = true;
    }
    expect(appUpdateThrew).toBe(true);

    // App role is REVOKE'd INSERT on aggregates (materialized only by the worker).
    let appAggInsertThrew = false;
    try {
      await withTenant(
        getTestSql(),
        tenantId,
        (tx) =>
          tx`INSERT INTO awcms_mini_usage_aggregates
             (tenant_id, meter_key, window_type, window_start, window_end, value_type, aggregation, content_hash)
           VALUES (${tenantId}, ${METER}, 'hour', now(), now() + interval '1 hour', 'count', 'sum', 'x')`
      );
    } catch {
      appAggInsertThrew = true;
    }
    expect(appAggInsertThrew).toBe(true);

    // Even a privileged in-place edit is blocked by the content-immutability trigger.
    let triggerThrew = false;
    try {
      const admin = getAdminSql();
      await admin`UPDATE awcms_mini_usage_events SET quantity = 0 WHERE id = ${eventId}`;
    } catch {
      triggerThrew = true;
    }
    expect(triggerThrew).toBe(true);
  });

  test("commit-reorder safe watermark (#900): a lower-seq event that COMMITS LATE is never skipped, and the cursor never passes an in-flight xid", async () => {
    const tenantId = await seedTenant("umreorder");
    const admin = getAdminSql();

    // Two OVERLAPPING transactions on dedicated connections. C1 opens first and
    // inserts the LOWER `ingest_seq` event (an EARLIER hour window, 09:00); C2
    // opens second and inserts the HIGHER `ingest_seq` event (a LATER window,
    // 10:00). C2 COMMITS FIRST; C1 commits LATER. The two windows are DISJOINT,
    // so recompute-from-source of one can never pull the other's event in — the
    // exact shape that makes an INSERT-order cursor permanently under-count.
    const c1 = await admin.reserve();
    const c2 = await admin.reserve();
    let xidLow = "";
    let xidHigh = "";
    try {
      await c1`BEGIN`;
      await c1`INSERT INTO awcms_mini_usage_events
        (tenant_id, meter_key, producer, source_event_id, value_type, aggregation, quantity, event_time)
        VALUES (${tenantId}, ${METER}, 'billing', 'reorder-low', 'count', 'sum', 4, '2026-07-19T09:15:00Z')`;
      xidLow = (
        (await c1`SELECT pg_current_xact_id()::text AS x`) as { x: string }[]
      )[0]!.x;

      await c2`BEGIN`;
      await c2`INSERT INTO awcms_mini_usage_events
        (tenant_id, meter_key, producer, source_event_id, value_type, aggregation, quantity, event_time)
        VALUES (${tenantId}, ${METER}, 'billing', 'reorder-high', 'count', 'sum', 6, '2026-07-19T10:20:00Z')`;
      xidHigh = (
        (await c2`SELECT pg_current_xact_id()::text AS x`) as { x: string }[]
      )[0]!.x;

      // The lower-seq producer drew the lower xid; the higher-seq one the higher xid.
      expect(BigInt(xidLow) < BigInt(xidHigh)).toBe(true);

      // C2 (higher seq/xid) commits; C1 (lower seq/xid) stays IN-FLIGHT.
      await c2`COMMIT`;

      // PASS 1 while C1 is in-flight: `safe = xmin` is pinned at C1's xid, so the
      // already-committed HIGHER-seq event is intentionally HELD BACK (never
      // processed ahead of the older in-flight transaction). An INSERT-order
      // cursor would instead process it and advance past it here.
      const r1 = await aggregate(tenantId);
      expect(r1.skipped).toBe(false);
      expect(r1.processed).toBe(0);
    } finally {
      // Ensure C1 commits even if an assertion above threw.
      if (xidLow) await c1`COMMIT`;
    }
    c1.release();
    c2.release();

    // Value of a specific hour window by its UTC start (tz-text-independent).
    async function hourWindowValue(startIso: string): Promise<number | null> {
      const rows = (await admin`
        SELECT aggregate_value::text AS v
        FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND meter_key = ${METER}
          AND window_type = 'hour' AND window_start = ${startIso}
      `) as { v: string }[];
      return rows[0] ? Number(rows[0].v) : null;
    }
    async function hourWindowCount(): Promise<number> {
      const rows = (await admin`
        SELECT count(*)::int AS n FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND meter_key = ${METER} AND window_type = 'hour'
      `) as { n: number }[];
      return rows[0]!.n;
    }

    // After PASS 1 the cursor floor must NOT have passed the in-flight xid (it
    // sits at/below the lower xid), and NEITHER window is materialized yet.
    const cursorAfter1 = (await admin`
      SELECT checkpoint_xid8::text AS x FROM awcms_mini_usage_aggregation_cursors
      WHERE tenant_id = ${tenantId} AND shard_key = 'default'
    `) as { x: string }[];
    expect(BigInt(cursorAfter1[0]!.x) < BigInt(xidHigh)).toBe(true);
    expect(await hourWindowCount()).toBe(0);

    // PASS 2 after C1 has committed: `safe` now clears both xids, so BOTH events
    // are drained. The LOWER-seq late-committing event's window is materialized —
    // it is NOT skipped (the regression). Both windows carry their exact value.
    const r2 = await aggregate(tenantId);
    expect(r2.processed).toBe(2);
    expect(await hourWindowValue("2026-07-19T09:00:00Z")).toBe(4); // late lower-seq event
    expect(await hourWindowValue("2026-07-19T10:00:00Z")).toBe(6); // higher-seq event
    expect(await hourWindowCount()).toBe(2);

    // The floor has now advanced past both settled transactions.
    const cursorAfter2 = (await admin`
      SELECT checkpoint_xid8::text AS x FROM awcms_mini_usage_aggregation_cursors
      WHERE tenant_id = ${tenantId} AND shard_key = 'default'
    `) as { x: string }[];
    expect(BigInt(cursorAfter2[0]!.x) > BigInt(xidHigh)).toBe(true);
  });

  test("the quota decision is fail-closed when the tenant has no entitlement", async () => {
    const tenantId = await seedTenant("umq");
    await append(tenantId, "e1", 5, "2026-07-19T10:10:00Z");
    await aggregate(tenantId);

    const decision = await withTenant(getTestSql(), tenantId, (tx) => {
      const entitlementPort = createEffectiveEntitlementPort(tx, tenantId, {
        catalogPort: createServiceCatalogReadPort(tx),
        moduleDescriptors: listModules()
      });
      const port = createUsageAggregatePort(
        tx,
        tenantId,
        registry,
        entitlementPort
      );
      return port.getQuotaDecision("usage_metering.sample_actions");
    });
    // No entitlement assignment + tenant_entitlement disabled -> deny (fail-closed).
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe("not_entitled");
  });

  // -------------------------------------------------------------------------
  // Issue #901 — the BOUNDED authoritative quota recompute (decomposition into
  // settled materialized sub-aggregates + a live open tail), which must stay
  // EXACTLY equivalent to the old unbounded full recompute AND fail closed.
  // -------------------------------------------------------------------------

  // The reset window (a full calendar month) + a `now` that puts every day
  // before the 20th SETTLED (day_end + 1h grace <= now) and the 20th's day the
  // OPEN tail. Shared by the #901 tests below.
  const MONTH_AT = new Date("2026-05-10T00:00:00Z");
  const NOW_20TH = new Date("2026-05-20T12:00:00Z");

  test("#901 sanity: month decomposes into day sub-windows", () => {
    expect(subWindowTypeFor("month")).toBe("day");
    expect(subWindowTypeFor("day")).toBe("hour");
    expect(subWindowTypeFor("hour")).toBe(null);
  });

  test("#901 equivalence: bounded usage == full recompute for sum/max/last across many days + open tail (incl. a correction on a settled day)", async () => {
    const tenantId = await seedTenant("um901eq");
    const { start, end } = windowBoundsFor("month", MONTH_AT);

    // sum meter — events on 3 settled days + 2 open-tail (05-20) events.
    const s1 = await appendMeter(
      tenantId,
      METER,
      "s1",
      2,
      "2026-05-03T08:00:00Z"
    );
    await appendMeter(tenantId, METER, "s2", 3, "2026-05-10T09:00:00Z");
    await appendMeter(tenantId, METER, "s3", 5, "2026-05-19T10:00:00Z");
    await appendMeter(tenantId, METER, "s4", 7, "2026-05-20T09:00:00Z");
    await appendMeter(tenantId, METER, "s5", 11, "2026-05-20T11:30:00Z");

    // max meter — settled peak (9 on 05-10) higher than the open-tail value (6).
    await appendMeter(tenantId, MAX_METER, "p1", 4, "2026-05-03T08:00:00Z");
    await appendMeter(tenantId, MAX_METER, "p2", 9, "2026-05-10T09:00:00Z");
    await appendMeter(tenantId, MAX_METER, "p3", 6, "2026-05-20T09:00:00Z");

    // last meter — the globally latest event is in the OPEN tail (300 on 05-20).
    await appendMeter(tenantId, LAST_METER, "l1", 100, "2026-05-03T08:00:00Z");
    await appendMeter(tenantId, LAST_METER, "l2", 200, "2026-05-19T10:00:00Z");
    await appendMeter(tenantId, LAST_METER, "l3", 300, "2026-05-20T09:00:00Z");

    // A signed correction on a SETTLED day (05-03) — the day sub-aggregate must
    // carry it (so summing settled sub-aggregates matches the full recompute).
    const originalEventId = s1.ok ? s1.eventId : "";
    await withTenant(getTestSql(), tenantId, (tx) =>
      applyCorrection(tx, tenantId, ACTOR, registry, {
        originalEventId,
        correctionType: "reversal",
        deltaQuantity: null,
        reason: "dup",
        producer: "billing",
        sourceEventId: "s1-rev",
        sourceVersion: 1
      })
    );

    // Materialize hour/day/month sub-aggregates for every touched settled day.
    await aggregate(tenantId);

    for (const meterKey of [METER, MAX_METER, LAST_METER]) {
      const bounded = await boundedUsed(
        tenantId,
        meterKey,
        start,
        end,
        NOW_20TH
      );
      const full = await fullRecomputeUsed(tenantId, meterKey, start, end);
      expect(bounded).toBe(full);
    }
    // Concrete oracles: sum = (2-2)+3+5+7+11 = 26; max = 9; last = 300.
    expect(await boundedUsed(tenantId, METER, start, end, NOW_20TH)).toBe(26);
    expect(await boundedUsed(tenantId, MAX_METER, start, end, NOW_20TH)).toBe(
      9
    );
    expect(await boundedUsed(tenantId, LAST_METER, start, end, NOW_20TH)).toBe(
      300
    );
  });

  test("#901 worker-lag over-admit guard: a SETTLED day with events but NO materialized aggregate is recomputed from source (never under-counts)", async () => {
    const tenantId = await seedTenant("um901lag");
    const { start, end } = windowBoundsFor("month", MONTH_AT);

    await appendMeter(tenantId, METER, "s1", 40, "2026-05-05T08:00:00Z"); // settled day
    await appendMeter(tenantId, METER, "s2", 2, "2026-05-20T09:00:00Z"); // open tail

    // Deliberately DO NOT run the worker — no day/month aggregate exists yet.
    const dayAggCount = await withTenant(getTestSql(), tenantId, async (tx) => {
      const rows = (await tx`
        SELECT count(*)::int AS n FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND meter_key = ${METER} AND window_type = 'day'
      `) as { n: number }[];
      return rows[0]!.n;
    });
    expect(dayAggCount).toBe(0);

    // The settled day's 40 MUST be recovered from source, not assumed 0.
    const bounded = await boundedUsed(tenantId, METER, start, end, NOW_20TH);
    expect(bounded).toBe(42);
    expect(bounded).toBe(await fullRecomputeUsed(tenantId, METER, start, end));
  });

  test("#901 open-tail freshness: a late event in the OPEN sub-window is counted LIVE even before it is aggregated", async () => {
    const tenantId = await seedTenant("um901tail");
    const { start, end } = windowBoundsFor("month", MONTH_AT);

    await appendMeter(tenantId, METER, "base", 10, "2026-05-05T08:00:00Z"); // settled
    await aggregate(tenantId); // materialize the settled day; open tail still empty

    // A brand-new OPEN-tail event that the worker has NOT processed yet.
    await appendMeter(tenantId, METER, "tail", 5, "2026-05-20T11:45:00Z");

    // 10 (from the settled sub-aggregate) + 5 (live open-tail recompute) = 15.
    expect(await boundedUsed(tenantId, METER, start, end, NOW_20TH)).toBe(15);
  });

  test("#901 unique_count is NOT decomposed: full recompute de-duplicates a subject seen across days (no double count)", async () => {
    const tenantId = await seedTenant("um901uniq");
    const { start, end } = windowBoundsFor("month", MONTH_AT);

    // subject-A appears on TWO different days — a naive per-day decomposition
    // would sum two distinct-counts and report it twice.
    await appendMeter(
      tenantId,
      UNIQUE_METER,
      "u1",
      1,
      "2026-05-03T08:00:00Z",
      "subject-A"
    );
    await appendMeter(
      tenantId,
      UNIQUE_METER,
      "u2",
      1,
      "2026-05-10T09:00:00Z",
      "subject-A"
    );
    await appendMeter(
      tenantId,
      UNIQUE_METER,
      "u3",
      1,
      "2026-05-19T10:00:00Z",
      "subject-B"
    );
    await appendMeter(
      tenantId,
      UNIQUE_METER,
      "u4",
      1,
      "2026-05-20T09:00:00Z",
      "subject-C"
    );
    await aggregate(tenantId);

    // Distinct subjects = {A, B, C} = 3, NOT 4.
    const bounded = await boundedUsed(
      tenantId,
      UNIQUE_METER,
      start,
      end,
      NOW_20TH
    );
    expect(bounded).toBe(3);
    expect(bounded).toBe(
      await fullRecomputeUsed(tenantId, UNIQUE_METER, start, end)
    );
  });

  test("#901 budget: a recompute that would exceed the source row budget THROWS (fail-closed) instead of an unbounded scan", async () => {
    const tenantId = await seedTenant("um901budget");
    const { start, end } = windowBoundsFor("month", MONTH_AT);

    // Three OPEN-tail events; a tiny injected budget of 2 must trip.
    await appendMeter(tenantId, METER, "b1", 1, "2026-05-20T09:00:00Z");
    await appendMeter(tenantId, METER, "b2", 1, "2026-05-20T09:01:00Z");
    await appendMeter(tenantId, METER, "b3", 1, "2026-05-20T09:02:00Z");

    let threwName = "";
    try {
      await boundedUsed(tenantId, METER, start, end, NOW_20TH, {
        maxSourceRows: 2
      });
    } catch (error) {
      threwName = error instanceof Error ? error.name : "unknown";
    }
    expect(threwName).toBe("QuotaSourceBudgetExceededError");
  });

  test("#901 port fail-closed: a budget-exceeded recompute makes an ENTITLED hard quota DENY (usage_unavailable)", async () => {
    const tenantId = await seedTenant("um901port");
    // Open-tail events beyond a tiny injected budget of 2.
    await appendMeter(tenantId, METER, "q1", 1, "2026-05-20T09:00:00Z");
    await appendMeter(tenantId, METER, "q2", 1, "2026-05-20T09:01:00Z");
    await appendMeter(tenantId, METER, "q3", 1, "2026-05-20T09:02:00Z");

    // Stub an ENTITLED allowance so the fail-closed branch (usage_unavailable),
    // not not_entitled, is what the decision exercises.
    const entitledStub: EffectiveEntitlementPort = {
      isFeatureAllowed: async () => true,
      isModuleEntitled: async () => true,
      getQuota: async () => ({
        allowed: true,
        isUnlimited: false,
        limit: 100,
        unit: "action"
      }),
      snapshot: async () => ({
        tenantId,
        resolvedAt: NOW_20TH.toISOString(),
        status: "resolved",
        snapshotHash: "stub",
        features: {},
        modules: {},
        quotas: {}
      })
    };

    const decision = await withTenant(getTestSql(), tenantId, (tx) => {
      const port = createUsageAggregatePort(
        tx,
        tenantId,
        registry,
        entitledStub,
        () => NOW_20TH,
        { quotaMaxSourceRows: 2 }
      );
      return port.getQuotaDecision(METER);
    });
    expect(decision.enforcement).toBe("hard");
    expect(decision.status).toBe("usage_unavailable");
    expect(decision.allowed).toBe(false);
  });

  test("#901 port happy path: an ENTITLED tenant within limit is allowed with bounded LIVE usage", async () => {
    const tenantId = await seedTenant("um901ok");
    await appendMeter(tenantId, METER, "h1", 4, "2026-05-05T08:00:00Z"); // settled
    await appendMeter(tenantId, METER, "h2", 3, "2026-05-20T09:00:00Z"); // open tail
    await aggregate(tenantId);

    const entitledStub: EffectiveEntitlementPort = {
      isFeatureAllowed: async () => true,
      isModuleEntitled: async () => true,
      getQuota: async () => ({
        allowed: true,
        isUnlimited: false,
        limit: 100,
        unit: "action"
      }),
      snapshot: async () => ({
        tenantId,
        resolvedAt: NOW_20TH.toISOString(),
        status: "resolved",
        snapshotHash: "stub",
        features: {},
        modules: {},
        quotas: {}
      })
    };

    const decision = await withTenant(getTestSql(), tenantId, (tx) => {
      const port = createUsageAggregatePort(
        tx,
        tenantId,
        registry,
        entitledStub,
        () => NOW_20TH
      );
      return port.getQuotaDecision(METER);
    });
    expect(decision.status).toBe("within");
    expect(decision.allowed).toBe(true);
    expect(decision.used).toBe(7); // 4 settled + 3 open tail
    expect(decision.remaining).toBe(93);
  });

  test("#901 M1 over-admit guard: a PRESENT-but-STALE settled sub-aggregate (late-beyond-grace arrival after computed_at) is recomputed — a hard quota at limit DENIES, never ALLOWS", async () => {
    const tenantId = await seedTenant("um901stale");
    const { start, end } = windowBoundsFor("month", MONTH_AT);

    // Materialize a SETTLED day (05-05) with value V = 10. `now` for the worker
    // is fixed at 05-07 (past the day + 1h grace) so the day aggregate's
    // computed_at = 05-07, deterministically BEFORE any real-clock received_at.
    await appendMeter(tenantId, METER, "orig", 10, "2026-05-05T08:00:00Z");
    await aggregate(tenantId, new Date("2026-05-07T00:00:00Z"));
    // The materialized settled day currently reads 10.
    const materialized = await withTenant(
      getTestSql(),
      tenantId,
      async (tx) => {
        const rows = (await tx`
        SELECT aggregate_value::text AS v FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND meter_key = ${METER}
          AND window_type = 'day' AND window_start = '2026-05-05T00:00:00Z'
      `) as { v: string }[];
        return rows[0] ? Number(rows[0].v) : null;
      }
    );
    expect(materialized).toBe(10);

    // A LATE-BEYOND-GRACE event lands in the already-settled 05-05 window
    // (event_time inside it, received_at = real clock >> computed_at 05-07),
    // Q = 7, and the worker is DELIBERATELY NOT re-run — the stored aggregate
    // now UNDER-counts (10 instead of 17).
    await appendMeter(
      tenantId,
      METER,
      "late-beyond-grace",
      7,
      "2026-05-05T09:00:00Z"
    );

    // The stale materialized value (10) must NOT be trusted: the bounded recompute
    // detects the post-materialization arrival and re-reads 05-05 from source -> 17.
    expect(await boundedUsed(tenantId, METER, start, end, NOW_20TH)).toBe(17);
    expect(await boundedUsed(tenantId, METER, start, end, NOW_20TH)).toBe(
      await fullRecomputeUsed(tenantId, METER, start, end)
    );

    // End-to-end at the port with a hard quota whose limit (15) sits BETWEEN the
    // stale value (10 -> would ALLOW) and the true value (17 -> must DENY).
    const entitledStub: EffectiveEntitlementPort = {
      isFeatureAllowed: async () => true,
      isModuleEntitled: async () => true,
      getQuota: async () => ({
        allowed: true,
        isUnlimited: false,
        limit: 15,
        unit: "action"
      }),
      snapshot: async () => ({
        tenantId,
        resolvedAt: NOW_20TH.toISOString(),
        status: "resolved",
        snapshotHash: "stub",
        features: {},
        modules: {},
        quotas: {}
      })
    };
    const decision = await withTenant(getTestSql(), tenantId, (tx) => {
      const port = createUsageAggregatePort(
        tx,
        tenantId,
        registry,
        entitledStub,
        () => NOW_20TH
      );
      return port.getQuotaDecision(METER);
    });
    expect(decision.used).toBe(17); // true committed usage, not the stale 10
    expect(decision.status).toBe("exceeded");
    expect(decision.allowed).toBe(false); // hard quota DENIES — no over-admit
  });
});
