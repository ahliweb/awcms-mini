export type SyncPushEvent = {
  eventType: string;
  aggregateType: string;
  aggregateId?: string;
  payload: unknown;
};

export type SyncPushRequestBody = {
  batchId: string;
  events: SyncPushEvent[];
};

export type ValidationError = {
  field: string;
  message: string;
};

export type SyncPushValidationResult =
  | { valid: true; value: SyncPushRequestBody }
  | { valid: false; errors: ValidationError[] };

export function validateSyncPushRequestBody(
  body: unknown
): SyncPushValidationResult {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;

  if (
    typeof record.batchId !== "string" ||
    record.batchId.trim().length === 0
  ) {
    errors.push({ field: "batchId", message: "batchId is required." });
  }

  if (!Array.isArray(record.events) || record.events.length === 0) {
    errors.push({
      field: "events",
      message: "events must be a non-empty array."
    });
  } else {
    record.events.forEach((event, index) => {
      const candidate = (event ?? {}) as Record<string, unknown>;

      if (
        typeof candidate.eventType !== "string" ||
        candidate.eventType.trim().length === 0
      ) {
        errors.push({
          field: `events[${index}].eventType`,
          message: "eventType is required."
        });
      }

      if (
        typeof candidate.aggregateType !== "string" ||
        candidate.aggregateType.trim().length === 0
      ) {
        errors.push({
          field: `events[${index}].aggregateType`,
          message: "aggregateType is required."
        });
      }

      if (!("payload" in candidate)) {
        errors.push({
          field: `events[${index}].payload`,
          message: "payload is required."
        });
      }
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      batchId: (record.batchId as string).trim(),
      events: (record.events as SyncPushEvent[]).map((event) => ({
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload
      }))
    }
  };
}
