/**
 * Operator-safe outbound delivery replay (Issue #754: "an operator can
 * manually retry a failed delivery without risking double-processing").
 * Mirrors `domain_event_runtime/application/delivery-replay.ts`'s shape:
 * creates a NEW delivery row referencing the original via
 * `replay_of_delivery_id`, rather than mutating/re-queuing the original —
 * the partial unique dedup index on `awcms_mini_integration_outbound_
 * deliveries` (`(tenant_id, subscription_id, source_event_id) WHERE
 * replay_of_delivery_id IS NULL`) deliberately EXCLUDES replay rows, so
 * more than one replay of the same original is structurally possible
 * (an operator retrying twice creates two independent new delivery
 * attempts) — the actual "don't double-process" guarantee for the HTTP
 * PATCH replay ACTION ITSELF comes from the standard `Idempotency-Key`
 * mechanism at the API layer (same key + same payload replays the SAME
 * stored response, never creates a second replay row), not from this
 * function. Only a `dead_letter` original may be replayed — a `pending`/
 * `sending`/`retry_wait` delivery is already going to be attempted again
 * naturally by the dispatch job, and `delivered` never needs one.
 */
export class DeliveryNotFoundError extends Error {
  constructor() {
    super("Outbound delivery not found.");
    this.name = "DeliveryNotFoundError";
  }
}

export class DeliveryNotReplayableError extends Error {
  readonly currentStatus: string;
  constructor(currentStatus: string) {
    super(
      `Only a dead_letter delivery can be replayed (current status: "${currentStatus}").`
    );
    this.name = "DeliveryNotReplayableError";
    this.currentStatus = currentStatus;
  }
}

type OriginalDeliveryRow = {
  id: string;
  subscription_id: string;
  source_event_id: string;
  event_type: string;
  max_attempts: number;
  status: string;
  correlation_id: string | null;
};

export type ReplayOutboundDeliveryResult = {
  newDeliveryId: string;
  originalDeliveryId: string;
};

/**
 * `reason` is not persisted by this function itself — the caller (`POST
 * /api/v1/integration-hub/deliveries/outbound/{id}/replay`) records it as
 * an audit-log attribute via `recordAuditEvent` (skill
 * `awcms-mini-audit-log` convention: this stays a pure data-layer
 * operation, the route handler owns the audit write). Still required at
 * the API layer via request-body validation before this function is ever
 * called.
 */
export async function replayOutboundDelivery(
  tx: Bun.SQL,
  tenantId: string,
  deliveryId: string
): Promise<ReplayOutboundDeliveryResult> {
  const originalRows = (await tx`
    SELECT id, subscription_id, source_event_id, event_type, max_attempts, status, correlation_id
    FROM awcms_mini_integration_outbound_deliveries
    WHERE tenant_id = ${tenantId} AND id = ${deliveryId}
  `) as OriginalDeliveryRow[];

  const original = originalRows[0];

  if (!original) {
    throw new DeliveryNotFoundError();
  }

  if (original.status !== "dead_letter") {
    throw new DeliveryNotReplayableError(original.status);
  }

  const insertedRows = (await tx`
    INSERT INTO awcms_mini_integration_outbound_deliveries
      (tenant_id, subscription_id, source_event_id, event_type, max_attempts,
       replay_of_delivery_id, correlation_id)
    VALUES (
      ${tenantId}, ${original.subscription_id}, ${original.source_event_id},
      ${original.event_type}, ${original.max_attempts}, ${original.id}, ${original.correlation_id}
    )
    RETURNING id
  `) as { id: string }[];

  const newDeliveryId = insertedRows[0]!.id;

  return { newDeliveryId, originalDeliveryId: original.id };
}
