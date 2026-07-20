/**
 * `usage_append` capability adapter (Issue #875, epic #868, ADR-0022 §2).
 * `usage_metering` PROVIDES this port; a producing module wires it at ITS
 * composition root and calls it in ITS OWN transaction so the usage event
 * commits atomically with the business transaction it describes (the
 * domain-event/outbox pattern — no provider call, no separate transaction).
 *
 * FAIL-CLOSED + IDEMPOTENT: the meter key resolves against the #874 single
 * source (unknown -> `unknown_meter`); the numeric-only draft is validated
 * (bounds, sign, skew, admitted dimensions); the INSERT is `ON CONFLICT DO
 * NOTHING` against the (tenant, producer, meter, sourceEventId, sourceVersion)
 * idempotency identity, so a duplicate producer event replays the winning row
 * (counted once). `tenantId` is the caller's own tenant context — a producer
 * can never record usage for another tenant.
 */
import type {
  UsageAppendInput,
  UsageAppendPort,
  UsageAppendResult
} from "../../_shared/ports/usage-append-port";
import { validateUsageEventDraft } from "../domain/usage-event";
import { resolveMeter, type SaasContractRegistry } from "./meter-registry";

function coerceEventTime(value: string | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Build the append port bound to a resolved #874 registry (from
 * `buildContractRegistry(listModules())` at the composition root).
 */
export function createUsageAppendPort(
  registry: SaasContractRegistry,
  nowProvider: () => Date = () => new Date()
): UsageAppendPort {
  return async function appendUsage(
    tx: Bun.SQL,
    tenantId: string,
    input: UsageAppendInput
  ): Promise<UsageAppendResult> {
    const meter = resolveMeter(registry, input.meterKey);
    if (!meter) {
      return { ok: false, reason: "unknown_meter" };
    }

    const validation = validateUsageEventDraft(
      meter,
      {
        meterKey: input.meterKey,
        producer: input.producer,
        sourceEventId: input.sourceEventId,
        sourceVersion: input.sourceVersion ?? 1,
        quantity: input.quantity,
        uniqueDimension: input.uniqueDimension ?? null,
        dimensions: input.dimensions,
        eventTime: coerceEventTime(input.eventTime)
      },
      nowProvider()
    );
    if (!validation.ok) {
      return { ok: false, reason: "validation", errors: validation.errors };
    }
    const event = validation.normalized;

    const inserted = (await tx`
      INSERT INTO awcms_mini_usage_events
        (tenant_id, meter_key, producer, source_event_id, source_version, value_type, aggregation,
         quantity, unique_dimension, dimensions, event_time, correlation_id, created_by)
      VALUES (
        ${tenantId}, ${event.meterKey}, ${event.producer}, ${event.sourceEventId}, ${event.sourceVersion},
        ${event.valueType}, ${event.aggregation}, ${event.quantity}, ${event.uniqueDimension},
        ${event.dimensions}::jsonb, ${event.eventTime}, ${input.correlationId ?? null},
        ${input.actorTenantUserId ?? null}
      )
      ON CONFLICT (tenant_id, producer, meter_key, source_event_id, source_version) DO NOTHING
      RETURNING id, ingest_seq
    `) as { id: string; ingest_seq: number | string }[];

    if (inserted.length > 0) {
      return {
        ok: true,
        eventId: inserted[0]!.id,
        ingestSeq: Number(inserted[0]!.ingest_seq),
        deduplicated: false
      };
    }

    // Duplicate producer event: replay the winning row (counted once).
    const winner = (await tx`
      SELECT id, ingest_seq FROM awcms_mini_usage_events
      WHERE tenant_id = ${tenantId} AND producer = ${event.producer}
        AND meter_key = ${event.meterKey} AND source_event_id = ${event.sourceEventId}
        AND source_version = ${event.sourceVersion}
    `) as { id: string; ingest_seq: number | string }[];

    return {
      ok: true,
      eventId: winner[0]!.id,
      ingestSeq: Number(winner[0]!.ingest_seq),
      deduplicated: true
    };
  };
}
