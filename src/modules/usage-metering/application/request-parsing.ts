/**
 * Defensive parsing of untrusted JSON request bodies (Issue #875, epic #868).
 * FAIL-CLOSED tri-state (epic pattern #6, same discipline as
 * `tenant-entitlement/application/request-parsing.ts`):
 *   - ABSENT scalar/enum field -> its default;
 *   - PRESENT field -> kept VERBATIM (cast) so the domain/route validator rejects
 *     a wrong type/value (400) — never coerced;
 *   - nullable field -> tri-state: absent -> null; present -> verbatim.
 * VALUE validity (bounds, known keys, enums) is the domain/route layer's job.
 */
import type { CorrectionType } from "../domain/usage-event";
import type { WindowType } from "../domain/meter-semantics";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableAtCreate(
  record: Record<string, unknown>,
  key: string
): unknown {
  return key in record ? record[key] : null;
}

export type CorrectionBody = {
  originalEventId: string;
  correctionType: CorrectionType;
  deltaQuantity: number | null;
  reason: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
};

export function parseCorrectionBody(body: unknown): CorrectionBody {
  const record = asRecord(body);
  return {
    originalEventId: asString(record.originalEventId),
    // present-but-invalid correctionType passes through verbatim -> validator rejects.
    correctionType: ("correctionType" in record
      ? asString(record.correctionType)
      : "") as CorrectionType,
    // tri-state nullable number: absent -> null; present -> verbatim.
    deltaQuantity: nullableAtCreate(record, "deltaQuantity") as number | null,
    // reason is REQUIRED — absent/blank kept as-is so the validator rejects (400).
    reason: "reason" in record ? (record.reason as string) : "",
    producer: "producer" in record ? asString(record.producer) : "operator",
    sourceEventId: asString(record.sourceEventId),
    sourceVersion:
      "sourceVersion" in record ? (record.sourceVersion as number) : 1
  };
}

export type ReconcileBody = {
  meterKey: string | null;
  windowType: WindowType;
  rangeFrom: string;
  rangeTo: string;
};

export function parseReconcileBody(body: unknown): ReconcileBody {
  const record = asRecord(body);
  return {
    // tri-state nullable: absent -> null (all meters); present -> verbatim.
    meterKey: nullableAtCreate(record, "meterKey") as string | null,
    // present-but-invalid windowType passes through verbatim -> route rejects.
    windowType: ("windowType" in record
      ? asString(record.windowType)
      : "day") as WindowType,
    rangeFrom: asString(record.rangeFrom),
    rangeTo: asString(record.rangeTo)
  };
}
