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
import { log } from "../../../lib/logging/logger";
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
/**
 * Source-row DISCOVERY is KEYSET-PAGED (Issue #902 L3), not a single capped
 * LIMIT: a window whose only evidence lay beyond a hard cap could otherwise be
 * neither `missing` nor `drift`-flagged — a silent completeness gap. Each page
 * reads this many source rows by `ingest_seq` keyset; the `windows` Set it
 * populates is bounded by the number of DISTINCT windows in range (tiny), not by
 * the row count, so memory stays bounded across arbitrarily many pages.
 */
const RECON_DISCOVERY_PAGE_ROWS = 50_000;
/**
 * A HARD safety bound on total source rows scanned during discovery (per
 * stream), so a pathological range can never spin unbounded. NEVER a silent
 * truncation: if a stream hits this bound the run is marked
 * `discoveryIncomplete` (a report sentinel + DTO flag + a logged warning + a
 * warning-severity audit), so an incompletely-verified range can never be
 * reported as `consistent` without a visible trace. Overridable per call for
 * tests.
 */
const RECON_MAX_DISCOVERY_ROWS = 5_000_000;
const RECON_MAX_REPORT_ENTRIES = 500;

export type ReconcileInput = {
  meterKey: string | null;
  windowType: WindowType;
  rangeFrom: Date;
  rangeTo: Date;
};

/** Tuning knobs for discovery paging (defaults are production values; tests inject small ones to exercise the hard-bound path). */
export type ReconcileOptions = {
  discoveryPageRows?: number;
  maxDiscoveryRows?: number;
};

export type ReconciliationDriftEntry = {
  meterKey: string;
  windowStart: string;
  /**
   * `drift`/`missing` are per-window findings. `discovery_incomplete` is a run
   * sentinel (Issue #902 L3): discovery hit its hard row bound before draining a
   * source stream, so windows beyond that point may be unverified — the run must
   * never be trusted as fully `consistent`. `discoveryIncomplete` on the run DTO
   * is derived from the presence of this entry.
   */
  kind: "drift" | "missing" | "discovery_incomplete";
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
  /** True when discovery hit its hard row bound (Issue #902 L3) — windows beyond that point may be unverified, so the run must not be trusted as fully consistent. Derived from a `discovery_incomplete` report entry, so it survives a re-read via `listReconciliationRuns`. */
  discoveryIncomplete: boolean;
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

/** Whether a stored/returned report carries the Issue #902 L3 incomplete sentinel. */
function discoveryIncompleteFromReport(
  report: ReconciliationDriftEntry[]
): boolean {
  return report.some((entry) => entry.kind === "discovery_incomplete");
}

type DiscoveryPageRow = {
  meter_key: string;
  event_time: Date;
  ingest_seq: number | string;
};

type StreamDiscoveryResult = {
  rowsScanned: number;
  incomplete: boolean;
  /** The highest `ingest_seq` reached (what was dropped from, when incomplete). */
  lastSeq: number;
};

/**
 * Keyset-page one source stream (events OR corrections), bucketing every row's
 * `event_time` into the shared `windows` Set with the SAME `windowStartFor` the
 * worker uses (never SQL `date_trunc`, which truncates in the session timezone).
 * The Set is bounded by the distinct-window count, so paging is memory-bounded
 * regardless of row volume. Stops and flags `incomplete` (never silently
 * truncates) if the hard `maxRows` bound is reached before the stream drains.
 */
async function pageStreamDiscovery(
  fetchPage: (afterSeq: number, limit: number) => Promise<DiscoveryPageRow[]>,
  windowType: WindowType,
  windows: Map<string, WindowKey>,
  pageRows: number,
  maxRows: number
): Promise<StreamDiscoveryResult> {
  let afterSeq = 0;
  let rowsScanned = 0;

  for (;;) {
    const remaining = maxRows - rowsScanned;
    if (remaining <= 0) {
      return { rowsScanned, incomplete: true, lastSeq: afterSeq };
    }
    const limit = Math.min(pageRows, remaining);
    const rows = await fetchPage(afterSeq, limit);
    for (const row of rows) {
      const windowStart = windowStartFor(windowType, row.event_time);
      windows.set(windowKeyOf(row.meter_key, windowStart), {
        meterKey: row.meter_key,
        windowStart
      });
      const seq = Number(row.ingest_seq);
      if (seq > afterSeq) afterSeq = seq;
    }
    rowsScanned += rows.length;

    // A short page proves the stream is fully drained.
    if (rows.length < limit) {
      return { rowsScanned, incomplete: false, lastSeq: afterSeq };
    }
    // A full page that consumed the last of the hard budget: we cannot prove the
    // stream is drained -> incomplete (flagged, never silently dropped).
    if (rowsScanned >= maxRows) {
      return { rowsScanned, incomplete: true, lastSeq: afterSeq };
    }
  }
}

export async function runReconciliation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  registry: SaasContractRegistry,
  input: ReconcileInput,
  correlationId?: string,
  options: ReconcileOptions = {}
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

  // DISCOVERY (Issue #902 L3): keyset-page BOTH source streams — events AND
  // corrections (a window may have only a correction). Every row is bucketed
  // into `windows` with the same UTC `windowStartFor`; the Set stays bounded by
  // the distinct-window count, so this is memory-bounded at any volume. A hard
  // per-stream row bound guards against a pathological range; hitting it flags
  // the run incomplete rather than silently dropping windows.
  const pageRows = Math.max(
    1,
    options.discoveryPageRows ?? RECON_DISCOVERY_PAGE_ROWS
  );
  const maxDiscoveryRows = Math.max(
    1,
    options.maxDiscoveryRows ?? RECON_MAX_DISCOVERY_ROWS
  );

  const eventDiscovery = await pageStreamDiscovery(
    (afterSeq, limit) =>
      (meterFilter
        ? tx`
            SELECT meter_key, event_time, ingest_seq FROM awcms_mini_usage_events
            WHERE tenant_id = ${tenantId} AND meter_key = ${meterFilter}
              AND event_time >= ${input.rangeFrom} AND event_time < ${input.rangeTo}
              AND ingest_seq > ${afterSeq}
            ORDER BY ingest_seq ASC
            LIMIT ${limit}
          `
        : tx`
            SELECT meter_key, event_time, ingest_seq FROM awcms_mini_usage_events
            WHERE tenant_id = ${tenantId}
              AND event_time >= ${input.rangeFrom} AND event_time < ${input.rangeTo}
              AND ingest_seq > ${afterSeq}
            ORDER BY ingest_seq ASC
            LIMIT ${limit}
          `) as Promise<DiscoveryPageRow[]>,
    input.windowType,
    windows,
    pageRows,
    maxDiscoveryRows
  );

  const correctionDiscovery = await pageStreamDiscovery(
    (afterSeq, limit) =>
      (meterFilter
        ? tx`
            SELECT meter_key, event_time, ingest_seq FROM awcms_mini_usage_corrections
            WHERE tenant_id = ${tenantId} AND meter_key = ${meterFilter}
              AND event_time >= ${input.rangeFrom} AND event_time < ${input.rangeTo}
              AND ingest_seq > ${afterSeq}
            ORDER BY ingest_seq ASC
            LIMIT ${limit}
          `
        : tx`
            SELECT meter_key, event_time, ingest_seq FROM awcms_mini_usage_corrections
            WHERE tenant_id = ${tenantId}
              AND event_time >= ${input.rangeFrom} AND event_time < ${input.rangeTo}
              AND ingest_seq > ${afterSeq}
            ORDER BY ingest_seq ASC
            LIMIT ${limit}
          `) as Promise<DiscoveryPageRow[]>,
    input.windowType,
    windows,
    pageRows,
    maxDiscoveryRows
  );

  const discoveryIncomplete =
    eventDiscovery.incomplete || correctionDiscovery.incomplete;

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

  // NO SILENT TRUNCATION (Issue #902 L3): if discovery hit its hard bound, record
  // a durable sentinel in the report (so a re-read via `listReconciliationRuns`
  // still sees it) and LOG which stream was dropped and from where. The
  // `discoveryIncomplete` flag — not `status` (a fixed 3-value DB enum) — is the
  // authoritative "do not trust as fully consistent" signal.
  if (discoveryIncomplete) {
    report.push({
      meterKey: input.meterKey ?? "*",
      windowStart: input.rangeTo.toISOString(),
      kind: "discovery_incomplete",
      expectedValue:
        eventDiscovery.rowsScanned + correctionDiscovery.rowsScanned,
      storedValue: null,
      expectedHash: "",
      storedHash: null
    });
    log("warning", "usage reconciliation discovery hit its hard row bound", {
      module: MODULE_KEY,
      tenantId,
      meterKey: input.meterKey,
      windowType: input.windowType,
      maxDiscoveryRows,
      eventsIncomplete: eventDiscovery.incomplete,
      eventsRowsScanned: eventDiscovery.rowsScanned,
      eventsDroppedFromIngestSeq: eventDiscovery.incomplete
        ? eventDiscovery.lastSeq
        : null,
      correctionsIncomplete: correctionDiscovery.incomplete,
      correctionsRowsScanned: correctionDiscovery.rowsScanned,
      correctionsDroppedFromIngestSeq: correctionDiscovery.incomplete
        ? correctionDiscovery.lastSeq
        : null
    });
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
    severity:
      status === "consistent" && !discoveryIncomplete ? "info" : "warning",
    message: `Usage reconciliation ${status} (${windowsChecked} windows, ${driftCount} drift, ${missingCount} missing${discoveryIncomplete ? ", discovery INCOMPLETE" : ""}).`,
    attributes: {
      meterKey: input.meterKey,
      windowType: input.windowType,
      status,
      windowsChecked,
      driftCount,
      missingCount,
      discoveryIncomplete
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
      discoveryIncomplete: discoveryIncompleteFromReport(row.report),
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
    discoveryIncomplete: discoveryIncompleteFromReport(row.report),
    report: row.report,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString()
  }));
}
