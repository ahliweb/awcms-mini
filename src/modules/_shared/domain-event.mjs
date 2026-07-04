const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function randomId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

export function createDomainEvent(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("domain event input must be an object");
  }

  requireString(input.eventType, "eventType");
  requireString(input.sourceModule, "sourceModule");
  requireString(input.aggregateType, "aggregateType");
  requireString(input.aggregateId, "aggregateId");

  if (!EVENT_TYPE_PATTERN.test(input.eventType)) {
    throw new TypeError("eventType must use dotted snake_case, for example audit.log_recorded");
  }

  return Object.freeze({
    eventId: input.eventId ?? randomId(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? "1.0",
    scope: Object.freeze({ kind: "single_tenant" }),
    sourceModule: input.sourceModule,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actor: input.actor ? Object.freeze({ ...input.actor }) : undefined,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: Object.freeze({ ...(input.payload ?? {}) }),
    metadata: Object.freeze({
      schemaVersion: input.schemaVersion ?? "1.0",
      ...(input.metadata ?? {}),
    }),
  });
}
