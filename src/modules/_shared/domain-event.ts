export type DomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = {
  eventId: string;
  eventType: string;
  eventVersion: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  actor?: {
    userId?: string;
    profileId?: string;
  };
  correlationId?: string;
  causationId?: string;
  payload: TPayload;
  metadata: {
    sourceModule: string;
    schemaVersion: string;
  };
};

export function createDomainEvent<
  TPayload extends Record<string, unknown>,
>(input: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  sourceModule: string;
  payload: TPayload;
  eventId?: string;
  eventVersion?: string;
  occurredAt?: string;
  actor?: DomainEvent["actor"];
  correlationId?: string;
  causationId?: string;
  schemaVersion?: string;
}): DomainEvent<TPayload> {
  return {
    eventId: input.eventId ?? crypto.randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? "1.0",
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload,
    metadata: {
      sourceModule: input.sourceModule,
      schemaVersion: input.schemaVersion ?? "1.0",
    },
  };
}
