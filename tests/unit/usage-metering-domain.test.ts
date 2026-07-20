/**
 * Unit tests for the PURE usage_metering domain (Issue #875, epic #868,
 * ADR-0022) — no I/O. Covers the deterministic aggregation core (all four
 * semantics + late/out-of-order order-independence + content-hash
 * reproducibility), event/correction validation (bounds, sign, skew, dimension
 * admission, correction admissibility), the fail-closed quota decision matrix,
 * and structural dimension admission. The reconciliation drift signal is a
 * consequence of the hash-reproducibility asserted here: a lost/duplicated event
 * changes the recomputed value, so its hash diverges from the stored one.
 */
import { describe, expect, test } from "bun:test";

import {
  computeContentHash,
  computeWindowAggregate,
  contentHashProjection,
  windowEndFor,
  windowStartFor,
  windowTypeForResetPeriod,
  type AggregationSourceCorrection,
  type AggregationSourceEvent
} from "../../src/modules/usage-metering/domain/meter-semantics";
import {
  validateCorrectionDraft,
  validateUsageEventDraft,
  MAX_FUTURE_SKEW_MS,
  type ResolvedMeter
} from "../../src/modules/usage-metering/domain/usage-event";
import { admitDimensions } from "../../src/modules/usage-metering/domain/dimension-admission";
import { decideQuota } from "../../src/modules/usage-metering/domain/quota-decision";

const NOW = new Date("2026-07-20T12:00:00.000Z");

function sumMeter(over: Partial<ResolvedMeter> = {}): ResolvedMeter {
  return {
    key: "usage_metering.sample_actions",
    ownerModuleKey: "usage_metering",
    valueType: "count",
    aggregation: "sum",
    correction: "signed_delta",
    classification: "billable",
    privacyClassification: "non_personal",
    minValue: 0,
    maxValue: 9007199254740991,
    ...over
  };
}

function ev(
  over: Partial<AggregationSourceEvent> = {}
): AggregationSourceEvent {
  return {
    ingestSeq: 1,
    quantity: 1,
    uniqueDimension: null,
    eventTime: new Date("2026-07-20T12:30:00.000Z"),
    ...over
  };
}

describe("meter-semantics — window bucketing (UTC)", () => {
  test("windowStartFor/windowEndFor align to UTC calendar boundaries", () => {
    const at = new Date("2026-07-20T12:34:56.000Z");
    expect(windowStartFor("hour", at).toISOString()).toBe(
      "2026-07-20T12:00:00.000Z"
    );
    expect(windowEndFor("hour", windowStartFor("hour", at)).toISOString()).toBe(
      "2026-07-20T13:00:00.000Z"
    );
    expect(windowStartFor("day", at).toISOString()).toBe(
      "2026-07-20T00:00:00.000Z"
    );
    expect(windowStartFor("month", at).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );
    expect(
      windowEndFor("month", windowStartFor("month", at)).toISOString()
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  test("windowTypeForResetPeriod maps deterministically", () => {
    expect(windowTypeForResetPeriod("daily")).toBe("day");
    expect(windowTypeForResetPeriod("weekly")).toBe("day");
    expect(windowTypeForResetPeriod("monthly")).toBe("month");
    expect(windowTypeForResetPeriod("quarterly")).toBe("month");
    expect(windowTypeForResetPeriod("none")).toBe("month");
  });
});

describe("meter-semantics — deterministic aggregation", () => {
  test("sum adds events plus signed corrections", () => {
    const events = [ev({ quantity: 3 }), ev({ ingestSeq: 2, quantity: 5 })];
    const corrections: AggregationSourceCorrection[] = [
      { ingestSeq: 3, deltaQuantity: -2, eventTime: ev().eventTime }
    ];
    const agg = computeWindowAggregate("sum", "count", events, corrections);
    expect(agg.value).toBe(6);
    expect(agg.eventCount).toBe(2);
    expect(agg.correctionCount).toBe(1);
  });

  test("max takes the peak; last takes the latest by (eventTime, ingestSeq)", () => {
    const events = [
      ev({
        ingestSeq: 1,
        quantity: 10,
        eventTime: new Date("2026-07-20T12:10:00Z")
      }),
      ev({
        ingestSeq: 2,
        quantity: 4,
        eventTime: new Date("2026-07-20T12:50:00Z")
      })
    ];
    expect(computeWindowAggregate("max", "gauge", events, []).value).toBe(10);
    const last = computeWindowAggregate("last", "gauge", events, []);
    expect(last.value).toBe(4);
    expect(last.lastEventTime?.toISOString()).toBe("2026-07-20T12:50:00.000Z");
  });

  test("unique_count counts distinct pseudonymous keys", () => {
    const events = [
      ev({ uniqueDimension: "a" }),
      ev({ ingestSeq: 2, uniqueDimension: "b" }),
      ev({ ingestSeq: 3, uniqueDimension: "a" })
    ];
    const agg = computeWindowAggregate("unique_count", "count", events, []);
    expect(agg.value).toBe(2);
    expect(agg.distinctCount).toBe(2);
  });

  test("aggregation is ORDER-INDEPENDENT — a late/out-of-order event yields the identical value + hash", () => {
    const inOrder = [
      ev({ ingestSeq: 1, quantity: 2 }),
      ev({ ingestSeq: 2, quantity: 7 }),
      ev({ ingestSeq: 3, quantity: 4 })
    ];
    const shuffled = [inOrder[2]!, inOrder[0]!, inOrder[1]!];
    const proj = (events: AggregationSourceEvent[]) =>
      computeContentHash(
        contentHashProjection({
          meterKey: "usage_metering.sample_actions",
          windowType: "hour",
          windowStart: new Date("2026-07-20T12:00:00Z"),
          windowEnd: new Date("2026-07-20T13:00:00Z"),
          aggregation: "sum",
          valueType: "count",
          aggregate: computeWindowAggregate("sum", "count", events, [])
        })
      );
    expect(proj(inOrder)).toBe(proj(shuffled));
  });

  test("MUTATION SIGNAL: a lost or duplicated event changes the content hash (reconciliation would flag drift)", () => {
    const base = [
      ev({ ingestSeq: 1, quantity: 2 }),
      ev({ ingestSeq: 2, quantity: 3 })
    ];
    const withDuplicate = [...base, ev({ ingestSeq: 2, quantity: 3 })];
    const hashOf = (events: AggregationSourceEvent[]) =>
      computeContentHash(
        contentHashProjection({
          meterKey: "usage_metering.sample_actions",
          windowType: "hour",
          windowStart: new Date("2026-07-20T12:00:00Z"),
          windowEnd: new Date("2026-07-20T13:00:00Z"),
          aggregation: "sum",
          valueType: "count",
          aggregate: computeWindowAggregate("sum", "count", events, [])
        })
      );
    expect(hashOf(withDuplicate)).not.toBe(hashOf(base));
  });
});

describe("usage-event validation", () => {
  test("accepts a well-formed count event", () => {
    const result = validateUsageEventDraft(
      sumMeter(),
      {
        meterKey: "usage_metering.sample_actions",
        producer: "billing",
        sourceEventId: "evt-1",
        sourceVersion: 1,
        quantity: 5,
        uniqueDimension: null,
        dimensions: { region: "id" },
        eventTime: new Date("2026-07-20T11:59:00Z")
      },
      NOW
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a negative quantity (a decrease is a signed correction)", () => {
    const result = validateUsageEventDraft(
      sumMeter(),
      {
        meterKey: "usage_metering.sample_actions",
        producer: "billing",
        sourceEventId: "e",
        sourceVersion: 1,
        quantity: -1,
        uniqueDimension: null,
        dimensions: {},
        eventTime: NOW
      },
      NOW
    );
    expect(result.ok).toBe(false);
  });

  test("rejects an implausibly future event_time (clock-skew guard)", () => {
    const result = validateUsageEventDraft(
      sumMeter(),
      {
        meterKey: "usage_metering.sample_actions",
        producer: "billing",
        sourceEventId: "e",
        sourceVersion: 1,
        quantity: 1,
        uniqueDimension: null,
        dimensions: {},
        eventTime: new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS + 60_000)
      },
      NOW
    );
    expect(result.ok).toBe(false);
  });

  test("a unique_count meter REQUIRES a uniqueDimension; a non-unique meter forbids it", () => {
    const uniqueMeter = sumMeter({
      aggregation: "unique_count",
      correction: "none",
      privacyClassification: "pseudonymous"
    });
    const missing = validateUsageEventDraft(
      uniqueMeter,
      {
        meterKey: "m",
        producer: "p",
        sourceEventId: "e",
        sourceVersion: 1,
        quantity: 1,
        uniqueDimension: null,
        dimensions: {},
        eventTime: NOW
      },
      NOW
    );
    expect(missing.ok).toBe(false);

    const forbidden = validateUsageEventDraft(
      sumMeter(),
      {
        meterKey: "m",
        producer: "p",
        sourceEventId: "e",
        sourceVersion: 1,
        quantity: 1,
        uniqueDimension: "u",
        dimensions: {},
        eventTime: NOW
      },
      NOW
    );
    expect(forbidden.ok).toBe(false);
  });
});

describe("correction validation", () => {
  test("a reversal negates the original event's quantity exactly", () => {
    const result = validateCorrectionDraft(sumMeter(), 7, {
      correctionType: "reversal",
      deltaQuantity: null,
      reason: "duplicate charge",
      producer: "billing",
      sourceEventId: "c-1",
      sourceVersion: 1
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized.deltaQuantity).toBe(-7);
  });

  test("a non-signed_delta or non-sum meter cannot be corrected (fail-closed)", () => {
    const maxMeter = sumMeter({ aggregation: "max", correction: "none" });
    const result = validateCorrectionDraft(maxMeter, 5, {
      correctionType: "adjustment",
      deltaQuantity: -1,
      reason: "x",
      producer: "billing",
      sourceEventId: "c",
      sourceVersion: 1
    });
    expect(result.ok).toBe(false);
  });

  test("an adjustment requires an integer deltaQuantity", () => {
    const result = validateCorrectionDraft(sumMeter(), 5, {
      correctionType: "adjustment",
      deltaQuantity: null,
      reason: "x",
      producer: "billing",
      sourceEventId: "c",
      sourceVersion: 1
    });
    expect(result.ok).toBe(false);
  });
});

describe("dimension admission (structural, fail-closed)", () => {
  test("absent/null admit to the empty map", () => {
    expect(admitDimensions(undefined)).toEqual({ ok: true, dimensions: {} });
    expect(admitDimensions(null)).toEqual({ ok: true, dimensions: {} });
  });

  test("admits short scalar keys/values only", () => {
    const ok = admitDimensions({ region: "id", tier: 3 });
    expect(ok.ok).toBe(true);
  });

  test("rejects nested objects, arrays, booleans, and null values (not a payload)", () => {
    expect(admitDimensions({ a: { nested: 1 } }).ok).toBe(false);
    expect(admitDimensions({ a: [1, 2] }).ok).toBe(false);
    expect(admitDimensions({ a: true }).ok).toBe(false);
    expect(admitDimensions({ a: null }).ok).toBe(false);
  });

  test("rejects too many keys and unsafe key formats", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 20; i++) many[`k${i}`] = i;
    expect(admitDimensions(many).ok).toBe(false);
    expect(admitDimensions({ "Bad Key": "x" }).ok).toBe(false);
  });
});

describe("quota decision (fail-closed matrix)", () => {
  const allowance = (over = {}) => ({
    allowed: true,
    isUnlimited: false,
    limit: 100,
    unit: "action",
    ...over
  });

  test("not entitled -> deny", () => {
    const d = decideQuota({
      meterKey: "m",
      enforcement: "hard",
      allowance: {
        allowed: false,
        isUnlimited: false,
        limit: null,
        unit: null
      },
      used: 0,
      freshness: "current"
    });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe("not_entitled");
  });

  test("usage unavailable -> a HARD quota denies, a soft quota allows", () => {
    const hard = decideQuota({
      meterKey: "m",
      enforcement: "hard",
      allowance: allowance(),
      used: 0,
      freshness: "unavailable"
    });
    expect(hard.allowed).toBe(false);
    expect(hard.status).toBe("usage_unavailable");

    const soft = decideQuota({
      meterKey: "m",
      enforcement: "soft",
      allowance: allowance(),
      used: 0,
      freshness: "unavailable"
    });
    expect(soft.allowed).toBe(true);
  });

  test("unlimited -> within; within limit -> allowed; at/over limit -> hard blocks, soft allows", () => {
    expect(
      decideQuota({
        meterKey: "m",
        enforcement: "hard",
        allowance: allowance({ isUnlimited: true, limit: null }),
        used: 9999,
        freshness: "current"
      }).allowed
    ).toBe(true);

    expect(
      decideQuota({
        meterKey: "m",
        enforcement: "hard",
        allowance: allowance(),
        used: 50,
        freshness: "current"
      }).status
    ).toBe("within");

    const hardOver = decideQuota({
      meterKey: "m",
      enforcement: "hard",
      allowance: allowance(),
      used: 100,
      freshness: "current"
    });
    expect(hardOver.allowed).toBe(false);
    expect(hardOver.status).toBe("exceeded");

    const softOver = decideQuota({
      meterKey: "m",
      enforcement: "soft",
      allowance: allowance(),
      used: 100,
      freshness: "current"
    });
    expect(softOver.allowed).toBe(true);
    expect(softOver.status).toBe("exceeded");
  });
});
