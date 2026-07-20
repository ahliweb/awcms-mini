/**
 * Same-commit versioned event + audit helpers for `payment_gateway` (Issue
 * #877, epic patterns #6 audit + versioned events). Every high-risk state change
 * emits a versioned domain event (constants imported DIRECTLY from
 * `domain-event-runtime/domain/event-type-registry.ts` so the snapshot is
 * same-commit) and an audit record with MASKED provider references + safe error
 * classes only — never a provider secret / raw PII / raw provider message.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import type { AppendDomainEventInput } from "../../domain-event-runtime/application/append-domain-event";
import { PAYMENT_GATEWAY_EVENT_VERSION } from "../../domain-event-runtime/domain/event-type-registry";

export const PAYMENT_GATEWAY_MODULE_KEY = "payment_gateway";
export const PAYMENT_INTENT_AGGREGATE = "payment_gateway_intent";
export const PAYMENT_REFUND_AGGREGATE = "payment_gateway_refund";

export type EventCtx = {
  actorTenantUserId: string | null;
  correlationId: string | null;
};

/**
 * Build the `appendDomainEvent` input for a payment event (PURE — no I/O). The
 * `appendDomainEvent` CALL itself stays in each engine so the `#848` publish-root
 * derivation (`tests/unit/domain-event-consumer-registration-wiring.test.ts`)
 * can resolve every `eventType:` operand to its imported constant — a wrapper
 * that owned the `appendDomainEvent` call would be a "blind spot" (the operand
 * would be a parameter, not a resolvable constant). Callers pass the constant
 * imported DIRECTLY from `event-type-registry.ts` (same-commit snapshot).
 */
export function buildPaymentEventInput(input: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  payload: Record<string, unknown>;
  ctx: EventCtx;
}): AppendDomainEventInput {
  return {
    eventType: input.eventType,
    eventVersion: PAYMENT_GATEWAY_EVENT_VERSION,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    producerModule: PAYMENT_GATEWAY_MODULE_KEY,
    correlationId: input.ctx.correlationId,
    actorTenantUserId: input.ctx.actorTenantUserId,
    payload: input.payload
  };
}

export async function auditPayment(
  tx: Bun.SQL,
  tenantId: string,
  input: {
    action: string;
    resourceType: string;
    resourceId: string;
    severity: "info" | "warning" | "critical";
    message: string;
    attributes: Record<string, unknown>;
    ctx: EventCtx;
  }
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: input.ctx.actorTenantUserId ?? undefined,
    moduleKey: PAYMENT_GATEWAY_MODULE_KEY,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    severity: input.severity,
    message: input.message,
    attributes: input.attributes,
    correlationId: input.ctx.correlationId ?? undefined
  });
}
