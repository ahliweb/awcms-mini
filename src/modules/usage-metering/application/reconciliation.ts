/**
 * Usage reconciliation (Issue #875, epic #868, ADR-0022 §9 "reconciliation as
 * the final source of truth"). Independently RECOMPUTES each window in a bounded
 * range from the immutable events + corrections and compares it to the stored
 * materialized aggregate — flagging any window whose stored value/hash DRIFTS
 * from the recompute, or that is MISSING a stored aggregate entirely. It never
 * repairs in place (repair = a worker rebuild); it records immutable evidence.
 *
 * This is the mechanism the reconciliation MUTATION tests exercise: if the
 * aggregation ever duplicate-counted, or dropped a late event, the stored
 * aggregate would diverge from this independent recompute and the run's status
 * turns `drift_detected` (never silently `consistent`). Numeric-only report,
 * emitted `usage.reconciled` event, and audit — all in the caller's transaction.
 */
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  USAGE_METERING_EVENT_VERSION,
  USAGE_METERING_USAGE_RECONCILED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeContentHash,
  computeWindowAggregate,
  contentHashProjection,
  windowEndFor,
  windowStartFor,
  type WindowType
} from "../domain/meter-semantics";
import { resolveMeter, type SaasContractRegistry } from "./meter-registry";
import { readWindowSources } from "./usage-source-query";

const MODULE_KEY = "usage_metering";
const RECON_MAX_SOURCE_ROWS = 50_000;
const RECON_MAX_REPORT_ENTRIES = 500;

export type ReconcileInput = {
  meterKey: string | null;
  windowType: WindowType;
  rangeFrom: Date;
  rangeTo: Date;
};

export type ReconciliationDriftEntry = {
  meterKey: string;
  windowStart: string;
  kind: "drift" | "missing";
  expectedValue: number;
  storedValue: number | null;
  expectedHash: string;
  storedHash: string | null;
};

export type ReconciliationRunDto = {
  id: string;
  meterKey: string | null;
  windowType: WindowType;
  rangeFrom: string;
  rangeTo: string;
  status: "consistent" | "drift_detected" | "failed";
  windowsChecked: number;
  driftCount: number;
  missingCount: number;
  report: ReconciliationDriftEntry[];
  startedAt: string;
  finishedAt: string;
};

export type ReconcileResult =
  | { ok: true; run: ReconciliationRunDto }
  | {
      ok: false;
      reason: "validation";
      errors: { field: string; message: string }[];
    };

type WindowKey = { meterKey: string; windowStart: Date };

/** Deterministic map key for a (meter, windowStart) tuple. */
function windowKeyOf(meterKey: string, windowStart: Date): string {
  return `${meterKey}|${windowStart.toISOString()}`;
}

export async function runReconciliation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  registry: SaasContractRegistry,
  input: ReconcileInput,
  correlationId?: string
): Promise<ReconcileResult> {
  const errors: { field: string; message: string }[] = [];
  if (input.rangeTo.getTime() <= input.rangeFrom.getTime()) {
    errors.push({
      field: "rangeTo",
      message: "rangeTo must be after rangeFrom."
    });
  }
  if (input.meterKey !== null && !resolveMeter(registry, input.meterKey)) {
    errors.push({
      field: "meterKey",
      message: `unknown meter "${input.meterKey}" (fail-closed).`
    });
  }
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const startedAt = new Date();
  const meterFilter = input.meterKey;

  // Union of windows to check: every stored aggregate window in range PLUS every
  // window that has source events in range (JS-bucketed with the SAME UTC
  // windowStartFor the worker uses — never SQL date_trunc, which would truncate
  // in the session timezone).
  const windows = new Map<string, WindowKey>();

  const storedRows = (
    meterFilter
      ? await tx`
        SELECT meter_key, window_start, aggregate_value, content_hash
        FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND window_type = ${input.windowType}
          AND meter_key = ${meterFilter}
          AND window_start >= ${input.rangeFrom} AND window_start < ${input.rangeTo}
      `
      : await tx`
        SELECT meter_key, window_start, aggregate_value, content_hash
        FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND window_type = ${input.windowType}
          AND window_start >= ${input.rangeFrom} AND window_start < ${input.rangeTo}
      `
  ) as {
    meter_key: string;
    window_start: Date;
    aggregate_value: number | string;
    content_hash: string;
  }[];
  const storedByKey = new Map<string, { value: number; hash: string }>();
  for (const row of storedRows) {
    windows.set(windowKeyOf(row.meter_key, row.window_start), {
      meterKey: row.meter_key,
      windowStart: row.window_start
    });
    storedByKey.set(windowKeyOf(row.meter_key, row.window_start), {
      value: Number(row.aggregate_value),
      hash: row.content_hash
    });
  }

  const sourceRows = (
    meterFilter
      ? await tx`
        SELECT meter_key, event_time FROM awcms_mini_usage_events
        WHERE tenant_id = ${tenantId} AND meter_key = ${meterFilter}
          AND event_time >= ${input.rangeFrom} AND event_time < ${input.rangeTo}
        ORDER BY ingest_seq ASC
        LIMIT ${RECON_MAX_SOURCE_ROWS}
      `
      : await tx`
        SELECT meter_key, event_time FROM awcms_mini_usage_events
        WHERE tenant_id = ${tenantId}
          AND event_time >= ${input.rangeFrom} AND event_time < ${input.rangeTo}
        ORDER BY ingest_seq ASC
        LIMIT ${RECON_MAX_SOURCE_ROWS}
      `
  ) as { meter_key: string; event_time: Date }[];
  for (const row of sourceRows) {
    const windowStart = windowStartFor(input.windowType, row.event_time);
    windows.set(windowKeyOf(row.meter_key, windowStart), {
      meterKey: row.meter_key,
      windowStart
    });
  }

  // Recompute each candidate window and compare to the stored aggregate.
  const report: ReconciliationDriftEntry[] = [];
  let windowsChecked = 0;
  let driftCount = 0;
  let missingCount = 0;

  const orderedWindows = [...windows.values()].sort((a, b) => {
    if (a.meterKey !== b.meterKey) return a.meterKey < b.meterKey ? -1 : 1;
    return a.windowStart.getTime() - b.windowStart.getTime();
  });

  for (const window of orderedWindows) {
    const meter = resolveMeter(registry, window.meterKey);
    if (!meter) {
      continue; // unknown meter -> skip (cannot recompute)
    }
    windowsChecked += 1;
    const windowEnd = windowEndFor(input.windowType, window.windowStart);
    const sources = await readWindowSources(
      tx,
      tenantId,
      window.meterKey,
      window.windowStart,
      windowEnd,
      null
    );
    const aggregate = computeWindowAggregate(
      meter.aggregation,
      meter.valueType,
      sources.events,
      sources.corrections
    );
    const expectedHash = computeContentHash(
      contentHashProjection({
        meterKey: window.meterKey,
        windowType: input.windowType,
        windowStart: window.windowStart,
        windowEnd,
        aggregation: meter.aggregation,
        valueType: meter.valueType,
        aggregate
      })
    );
    const stored = storedByKey.get(
      windowKeyOf(window.meterKey, window.windowStart)
    );
    if (!stored) {
      missingCount += 1;
      if (report.length < RECON_MAX_REPORT_ENTRIES) {
        report.push({
          meterKey: window.meterKey,
          windowStart: window.windowStart.toISOString(),
          kind: "missing",
          expectedValue: aggregate.value,
          storedValue: null,
          expectedHash,
          storedHash: null
        });
      }
    } else if (stored.hash !== expectedHash) {
      driftCount += 1;
      if (report.length < RECON_MAX_REPORT_ENTRIES) {
        report.push({
          meterKey: window.meterKey,
          windowStart: window.windowStart.toISOString(),
          kind: "drift",
          expectedValue: aggregate.value,
          storedValue: stored.value,
          expectedHash,
          storedHash: stored.hash
        });
      }
    }
  }

  const status: ReconciliationRunDto["status"] =
    driftCount + missingCount === 0 ? "consistent" : "drift_detected";
  const finishedAt = new Date();

  const inserted = (await tx`
    INSERT INTO awcms_mini_usage_reconciliation_runs
      (tenant_id, meter_key, window_type, range_from, range_to, status,
       windows_checked, drift_count, missing_count, report, correlation_id, started_at, finished_at, created_by)
    VALUES (
      ${tenantId}, ${input.meterKey}, ${input.windowType}, ${input.rangeFrom}, ${input.rangeTo},
      ${status}, ${windowsChecked}, ${driftCount}, ${missingCount}, ${report}::jsonb,
      ${correlationId ?? null}, ${startedAt}, ${finishedAt}, ${actorTenantUserId}
    )
    RETURNING id, meter_key, window_type, range_from, range_to, status,
      windows_checked, drift_count, missing_count, report, started_at, finished_at
  `) as {
    id: string;
    meter_key: string | null;
    window_type: WindowType;
    range_from: Date;
    range_to: Date;
    status: ReconciliationRunDto["status"];
    windows_checked: number | string;
    drift_count: number | string;
    missing_count: number | string;
    report: ReconciliationDriftEntry[];
    started_at: Date;
    finished_at: Date;
  }[];
  const row = inserted[0]!;

  await appendDomainEvent(tx, tenantId, {
    eventType: USAGE_METERING_USAGE_RECONCILED_EVENT_TYPE,
    eventVersion: USAGE_METERING_EVENT_VERSION,
    aggregateType: "usage_reconciliation_run",
    aggregateId: row.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      runId: row.id,
      meterKey: input.meterKey,
      windowType: input.windowType,
      status,
      windowsChecked,
      driftCount,
      missingCount
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "reconcile",
    resourceType: "usage_reconciliation_run",
    resourceId: row.id,
    severity: status === "consistent" ? "info" : "warning",
    message: `Usage reconciliation ${status} (${windowsChecked} windows, ${driftCount} drift, ${missingCount} missing).`,
    attributes: {
      meterKey: input.meterKey,
      windowType: input.windowType,
      status,
      windowsChecked,
      driftCount,
      missingCount
    },
    correlationId
  });

  return {
    ok: true,
    run: {
      id: row.id,
      meterKey: row.meter_key,
      windowType: row.window_type,
      rangeFrom: row.range_from.toISOString(),
      rangeTo: row.range_to.toISOString(),
      status: row.status,
      windowsChecked: Number(row.windows_checked),
      driftCount: Number(row.drift_count),
      missingCount: Number(row.missing_count),
      report: row.report,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at.toISOString()
    }
  };
}

export async function listReconciliationRuns(
  tx: Bun.SQL,
  tenantId: string
): Promise<ReconciliationRunDto[]> {
  const rows = (await tx`
    SELECT id, meter_key, window_type, range_from, range_to, status,
      windows_checked, drift_count, missing_count, report, started_at, finished_at
    FROM awcms_mini_usage_reconciliation_runs
    WHERE tenant_id = ${tenantId}
    ORDER BY started_at DESC
    LIMIT 200
  `) as {
    id: string;
    meter_key: string | null;
    window_type: WindowType;
    range_from: Date;
    range_to: Date;
    status: ReconciliationRunDto["status"];
    windows_checked: number | string;
    drift_count: number | string;
    missing_count: number | string;
    report: ReconciliationDriftEntry[];
    started_at: Date;
    finished_at: Date;
  }[];
  return rows.map((row) => ({
    id: row.id,
    meterKey: row.meter_key,
    windowType: row.window_type,
    rangeFrom: row.range_from.toISOString(),
    rangeTo: row.range_to.toISOString(),
    status: row.status,
    windowsChecked: Number(row.windows_checked),
    driftCount: Number(row.drift_count),
    missingCount: Number(row.missing_count),
    report: row.report,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString()
  }));
}
