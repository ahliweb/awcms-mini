/**
 * Usage event + correction validation (Issue #875, epic #868, ADR-0022). PURE —
 * no I/O. Runs AFTER the meter key has been resolved against the #874 single
 * source (unknown meter fails closed upstream); given the resolved meter's
 * numeric semantics it enforces quantity bounds, sign rules, timestamp skew,
 * dimension admission, and correction semantics before anything is persisted.
 */
import {
  admitDimensions,
  type AdmittedDimensions
} from "./dimension-admission";
import {
  MAX_SAFE,
  type MeterAggregation,
  type MeterValueType
} from "./meter-semantics";

/** The numeric-only meter facts resolved from the #874 registry the validators need. */
export type ResolvedMeter = {
  key: string;
  ownerModuleKey: string;
  valueType: MeterValueType;
  aggregation: MeterAggregation;
  correction: "none" | "signed_delta";
  classification: "billable" | "informational";
  privacyClassification: "non_personal" | "pseudonymous" | "personal";
  minValue: number;
  maxValue: number;
};

export type UsageValidationError = { field: string; message: string };

/** Reject an event whose `event_time` is implausibly far in the future (clock-skew / spoofing guard). Late (past) events are allowed by design. */
export const MAX_FUTURE_SKEW_MS = 300_000; // 5 minutes

const PRODUCER_FORMAT = /^[a-z][a-z0-9_]*$/;

export type UsageEventDraft = {
  meterKey: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
  quantity: number;
  uniqueDimension: string | null;
  dimensions: unknown;
  eventTime: Date | null;
};

export type NormalizedUsageEvent = {
  meterKey: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
  valueType: MeterValueType;
  aggregation: MeterAggregation;
  quantity: number;
  uniqueDimension: string | null;
  dimensions: AdmittedDimensions;
  eventTime: Date;
};

export type UsageEventValidationResult =
  | { ok: true; normalized: NormalizedUsageEvent }
  | { ok: false; errors: UsageValidationError[] };

export function validateUsageEventDraft(
  meter: ResolvedMeter,
  draft: UsageEventDraft,
  now: Date
): UsageEventValidationResult {
  const errors: UsageValidationError[] = [];

  if (
    typeof draft.producer !== "string" ||
    !PRODUCER_FORMAT.test(draft.producer) ||
    draft.producer.length > 100
  ) {
    errors.push({
      field: "producer",
      message: "producer must match ^[a-z][a-z0-9_]*$ and be <= 100 chars."
    });
  }
  if (
    typeof draft.sourceEventId !== "string" ||
    draft.sourceEventId.length < 1 ||
    draft.sourceEventId.length > 200
  ) {
    errors.push({
      field: "sourceEventId",
      message: "sourceEventId must be 1..200 chars."
    });
  }
  if (!Number.isInteger(draft.sourceVersion) || draft.sourceVersion < 1) {
    errors.push({
      field: "sourceVersion",
      message: "sourceVersion must be a positive integer."
    });
  }

  // Quantity: a SOURCE event is always a non-negative integer within the meter's
  // upper bound (a decrease is a signed correction, never a negative event).
  if (!Number.isInteger(draft.quantity)) {
    errors.push({
      field: "quantity",
      message: "quantity must be a finite integer."
    });
  } else if (draft.quantity < 0) {
    errors.push({
      field: "quantity",
      message:
        "a source event quantity must be >= 0 (a decrease is a signed correction)."
    });
  } else if (draft.quantity > meter.maxValue) {
    errors.push({
      field: "quantity",
      message: `quantity ${draft.quantity} exceeds the meter's maxValue (${meter.maxValue}).`
    });
  } else if (draft.quantity > MAX_SAFE) {
    errors.push({
      field: "quantity",
      message: "quantity exceeds Number.MAX_SAFE_INTEGER."
    });
  }

  // Event time: valid + not implausibly future.
  if (
    !(draft.eventTime instanceof Date) ||
    Number.isNaN(draft.eventTime.getTime())
  ) {
    errors.push({
      field: "eventTime",
      message: "eventTime must be a valid ISO-8601 timestamp."
    });
  } else if (draft.eventTime.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    errors.push({
      field: "eventTime",
      message: "eventTime is implausibly far in the future (clock-skew guard)."
    });
  }

  // unique_dimension is REQUIRED for unique_count meters and forbidden otherwise.
  if (meter.aggregation === "unique_count") {
    if (
      draft.uniqueDimension === null ||
      typeof draft.uniqueDimension !== "string" ||
      draft.uniqueDimension.length < 1 ||
      draft.uniqueDimension.length > 200
    ) {
      errors.push({
        field: "uniqueDimension",
        message:
          "a unique_count meter requires a 1..200 char uniqueDimension (the distinct key)."
      });
    }
  } else if (draft.uniqueDimension !== null) {
    errors.push({
      field: "uniqueDimension",
      message: "uniqueDimension is only valid for a unique_count meter."
    });
  }

  const admitted = admitDimensions(draft.dimensions);
  if (!admitted.ok) {
    for (const e of admitted.errors) {
      errors.push({ field: e.field, message: e.message });
    }
  }

  if (errors.length > 0 || !admitted.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    normalized: {
      meterKey: meter.key,
      producer: draft.producer,
      sourceEventId: draft.sourceEventId,
      sourceVersion: draft.sourceVersion,
      valueType: meter.valueType,
      aggregation: meter.aggregation,
      quantity: draft.quantity,
      uniqueDimension:
        meter.aggregation === "unique_count" ? draft.uniqueDimension : null,
      dimensions: admitted.dimensions,
      eventTime: draft.eventTime as Date
    }
  };
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type CorrectionType = "reversal" | "adjustment";

export type CorrectionDraft = {
  correctionType: CorrectionType;
  /** Operator-supplied signed delta for an `adjustment`; ignored for a `reversal` (computed from the original event). */
  deltaQuantity: number | null;
  reason: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
};

export type NormalizedCorrection = {
  correctionType: CorrectionType;
  deltaQuantity: number;
  reason: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
};

export type CorrectionValidationResult =
  | { ok: true; normalized: NormalizedCorrection }
  | { ok: false; errors: UsageValidationError[] };

/**
 * Validate a correction against the resolved meter AND the original event's
 * quantity (for a reversal, the delta is the negation of the original; for an
 * adjustment, an operator-supplied signed delta). Only meters whose #874
 * descriptor declares `correction: "signed_delta"` AND `aggregation: "sum"`
 * accept corrections — `max`/`last`/`unique_count` cannot be corrected safely.
 */
export function validateCorrectionDraft(
  meter: ResolvedMeter,
  originalQuantity: number,
  draft: CorrectionDraft
): CorrectionValidationResult {
  const errors: UsageValidationError[] = [];

  if (meter.correction !== "signed_delta") {
    errors.push({
      field: "meterKey",
      message: `meter "${meter.key}" does not accept corrections (its #874 correction semantics are "${meter.correction}").`
    });
  }
  if (meter.aggregation !== "sum") {
    errors.push({
      field: "meterKey",
      message: `only a sum meter can be corrected; "${meter.key}" aggregates by "${meter.aggregation}".`
    });
  }
  if (
    draft.correctionType !== "reversal" &&
    draft.correctionType !== "adjustment"
  ) {
    errors.push({
      field: "correctionType",
      message: 'correctionType must be "reversal" or "adjustment".'
    });
  }
  if (
    typeof draft.reason !== "string" ||
    draft.reason.trim().length < 1 ||
    draft.reason.length > 500
  ) {
    errors.push({
      field: "reason",
      message: "reason is required (1..500 chars)."
    });
  }
  if (
    typeof draft.producer !== "string" ||
    !PRODUCER_FORMAT.test(draft.producer) ||
    draft.producer.length > 100
  ) {
    errors.push({
      field: "producer",
      message: "producer must match ^[a-z][a-z0-9_]*$ and be <= 100 chars."
    });
  }
  if (
    typeof draft.sourceEventId !== "string" ||
    draft.sourceEventId.length < 1 ||
    draft.sourceEventId.length > 200
  ) {
    errors.push({
      field: "sourceEventId",
      message: "sourceEventId must be 1..200 chars."
    });
  }
  if (!Number.isInteger(draft.sourceVersion) || draft.sourceVersion < 1) {
    errors.push({
      field: "sourceVersion",
      message: "sourceVersion must be a positive integer."
    });
  }

  let delta: number;
  if (draft.correctionType === "reversal") {
    // A reversal negates the original event's contribution exactly.
    delta = -originalQuantity;
  } else {
    if (
      draft.deltaQuantity === null ||
      !Number.isInteger(draft.deltaQuantity)
    ) {
      errors.push({
        field: "deltaQuantity",
        message: "an adjustment requires an integer deltaQuantity."
      });
      delta = 0;
    } else {
      delta = draft.deltaQuantity;
    }
  }

  if (Number.isInteger(delta) && (delta < -MAX_SAFE || delta > MAX_SAFE)) {
    errors.push({
      field: "deltaQuantity",
      message: "deltaQuantity magnitude exceeds Number.MAX_SAFE_INTEGER."
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    normalized: {
      correctionType: draft.correctionType,
      deltaQuantity: delta,
      reason: draft.reason,
      producer: draft.producer,
      sourceEventId: draft.sourceEventId,
      sourceVersion: draft.sourceVersion
    }
  };
}
