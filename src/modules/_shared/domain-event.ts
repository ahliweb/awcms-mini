/**
 * Domain event envelope (doc 10 & 05) — semua event antar modul memakai
 * amplop standard ini dan terdaftar di asyncapi/.
 * Event tidak boleh membawa raw sensitive data.
 */

export type DomainEventEnvelope<TPayload> = {
  eventId: string;
  eventType: string;
  eventVersion: string;
  tenantId: string;
  nodeId?: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  actor?: { tenantUserId?: string; profileId?: string };
  correlationId?: string;
  causationId?: string;
  payload: TPayload;
  metadata: {
    sourceModule: string;
    schemaVersion: string;
  };
};

export type CreateDomainEventInput<TPayload> = {
  eventType: string;
  eventVersion?: string;
  tenantId: string;
  nodeId?: string;
  aggregateType: string;
  aggregateId: string;
  actor?: { tenantUserId?: string; profileId?: string };
  correlationId?: string;
  causationId?: string;
  payload: TPayload;
  sourceModule: string;
  schemaVersion?: string;
};

export function createDomainEvent<TPayload>(
  input: CreateDomainEventInput<TPayload>
): DomainEventEnvelope<TPayload> {
  return {
    eventId: crypto.randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? "1.0",
    tenantId: input.tenantId,
    nodeId: input.nodeId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: new Date().toISOString(),
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload,
    metadata: {
      sourceModule: input.sourceModule,
      schemaVersion: input.schemaVersion ?? "1.0"
    }
  };
}
