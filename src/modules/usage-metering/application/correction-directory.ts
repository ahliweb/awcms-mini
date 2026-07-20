/**
 * Usage corrections (Issue #875, epic #868, ADR-0022). Applies a signed
 * correction/reversal LINKED to an original immutable event — it NEVER mutates
 * the source event (append-only, ADR-0005). The correction lands in the window
 * of the ORIGINAL event's `event_time`, so a reversal exactly negates the
 * original's contribution to its window on the next aggregation pass.
 *
 * Every correction: resolves its meter against #874 (fail-closed unknown),
 * validates correction semantics (only a signed_delta sum meter can be
 * corrected), INSERTs with an idempotency identity (`ON CONFLICT DO NOTHING` ->
 * a clean conflict the route replays), emits a numeric-only `usage.corrected`
 * event, and is audited (WITHOUT the reason free-text in the event payload) —
 * all in the caller's `withTenant` transaction (same-commit).
 */
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  USAGE_METERING_EVENT_VERSION,
  USAGE_METERING_USAGE_CORRECTED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateCorrectionDraft,
  type CorrectionType,
  type UsageValidationError
} from "../domain/usage-event";
import { resolveMeter, type SaasContractRegistry } from "./meter-registry";

const MODULE_KEY = "usage_metering";

export type UsageCorrectionDto = {
  id: string;
  originalEventId: string;
  meterKey: string;
  correctionType: CorrectionType;
  deltaQuantity: number;
  reason: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
  eventTime: string;
  createdAt: string;
};

export type ApplyCorrectionInput = {
  originalEventId: string;
  correctionType: CorrectionType;
  deltaQuantity: number | null;
  reason: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
};

export type ApplyCorrectionResult =
  | { ok: true; correction: UsageCorrectionDto }
  | { ok: false; reason: "unknown_meter" }
  | { ok: false; reason: "event_not_found" }
  | { ok: false; reason: "validation"; errors: UsageValidationError[] }
  | { ok: false; reason: "conflict" };

type CorrectionRow = {
  id: string;
  original_event_id: string;
  meter_key: string;
  correction_type: CorrectionType;
  delta_quantity: number | string;
  reason: string;
  producer: string;
  source_event_id: string;
  source_version: number | string;
  event_time: Date;
  created_at: Date;
};

function toDto(row: CorrectionRow): UsageCorrectionDto {
  return {
    id: row.id,
    originalEventId: row.original_event_id,
    meterKey: row.meter_key,
    correctionType: row.correction_type,
    deltaQuantity: Number(row.delta_quantity),
    reason: row.reason,
    producer: row.producer,
    sourceEventId: row.source_event_id,
    sourceVersion: Number(row.source_version),
    eventTime: row.event_time.toISOString(),
    createdAt: row.created_at.toISOString()
  };
}

export async function applyCorrection(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  registry: SaasContractRegistry,
  input: ApplyCorrectionInput,
  correlationId?: string
): Promise<ApplyCorrectionResult> {
  // The original immutable event (RLS confines it to this tenant).
  const originals = (await tx`
    SELECT id, meter_key, quantity, event_time
    FROM awcms_mini_usage_events
    WHERE tenant_id = ${tenantId} AND id = ${input.originalEventId}
  `) as {
    id: string;
    meter_key: string;
    quantity: number | string;
    event_time: Date;
  }[];
  if (!originals[0]) {
    return { ok: false, reason: "event_not_found" };
  }
  const original = originals[0];

  const meter = resolveMeter(registry, original.meter_key);
  if (!meter) {
    return { ok: false, reason: "unknown_meter" };
  }

  const validation = validateCorrectionDraft(meter, Number(original.quantity), {
    correctionType: input.correctionType,
    deltaQuantity: input.deltaQuantity,
    reason: input.reason,
    producer: input.producer,
    sourceEventId: input.sourceEventId,
    sourceVersion: input.sourceVersion
  });
  if (!validation.ok) {
    return { ok: false, reason: "validation", errors: validation.errors };
  }
  const correction = validation.normalized;

  // Idempotency identity (tenant, producer, meter, sourceEventId, sourceVersion)
  // -> a duplicate is a clean conflict the route replays. The correction lands
  // in the ORIGINAL event's window (event_time snapshotted from the original).
  const inserted = (await tx`
    INSERT INTO awcms_mini_usage_corrections
      (tenant_id, original_event_id, meter_key, correction_type, delta_quantity, reason,
       producer, source_event_id, source_version, event_time, correlation_id, created_by)
    VALUES (
      ${tenantId}, ${original.id}, ${original.meter_key}, ${correction.correctionType},
      ${correction.deltaQuantity}, ${correction.reason}, ${correction.producer},
      ${correction.sourceEventId}, ${correction.sourceVersion}, ${original.event_time},
      ${correlationId ?? null}, ${actorTenantUserId}
    )
    ON CONFLICT (tenant_id, producer, meter_key, source_event_id, source_version) DO NOTHING
    RETURNING id, original_event_id, meter_key, correction_type, delta_quantity, reason,
      producer, source_event_id, source_version, event_time, created_at
  `) as CorrectionRow[];

  if (inserted.length === 0) {
    return { ok: false, reason: "conflict" };
  }
  const dto = toDto(inserted[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: USAGE_METERING_USAGE_CORRECTED_EVENT_TYPE,
    eventVersion: USAGE_METERING_EVENT_VERSION,
    aggregateType: "usage_correction",
    aggregateId: dto.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    // Numeric-only payload — NEVER the operator's free-text reason (ADR-0022 §8).
    payload: {
      correctionId: dto.id,
      originalEventId: dto.originalEventId,
      meterKey: dto.meterKey,
      correctionType: dto.correctionType,
      deltaQuantity: dto.deltaQuantity
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "correct",
    resourceType: "usage_correction",
    resourceId: dto.id,
    severity: "warning",
    message: `Usage ${dto.correctionType} applied to meter "${dto.meterKey}" (delta ${dto.deltaQuantity}).`,
    attributes: {
      meterKey: dto.meterKey,
      originalEventId: dto.originalEventId,
      correctionType: dto.correctionType,
      deltaQuantity: dto.deltaQuantity,
      reason: dto.reason
    },
    correlationId
  });

  return { ok: true, correction: dto };
}

export async function listCorrections(
  tx: Bun.SQL,
  tenantId: string,
  meterKey: string | null
): Promise<UsageCorrectionDto[]> {
  const rows = (
    meterKey
      ? await tx`
        SELECT id, original_event_id, meter_key, correction_type, delta_quantity, reason,
          producer, source_event_id, source_version, event_time, created_at
        FROM awcms_mini_usage_corrections
        WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
        ORDER BY created_at DESC
        LIMIT 500
      `
      : await tx`
        SELECT id, original_event_id, meter_key, correction_type, delta_quantity, reason,
          producer, source_event_id, source_version, event_time, created_at
        FROM awcms_mini_usage_corrections
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
        LIMIT 500
      `
  ) as CorrectionRow[];
  return rows.map(toDto);
}
