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

const registry = buildContractRegistry(listModules());
const ACTOR = "00000000-0000-0000-0000-0000000000aa";
const METER = "usage_metering.sample_actions"; // sum + signed_delta
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
});
