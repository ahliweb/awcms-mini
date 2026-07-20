/**
 * `usage_append` capability port (Issue #875, epic #868 SaaS control plane,
 * ADR-0022 §2). The TRANSACTION-SAFE seam through which an owning/business
 * module records a reviewed meter EVENT in the SAME commit as the business
 * transaction it describes (the domain-event/outbox pattern — the usage_events
 * table IS the transactional outbox the aggregation worker later drains OUTSIDE
 * this transaction). The owning module imports only this TYPE from neutral
 * `_shared/` ground; the concrete adapter
 * (`usage-metering/application/usage-append-adapter.ts`) is wired at the
 * composition root (a route/job handler), never a direct cross-module import
 * (enforced by `tests/unit/module-boundary.test.ts`).
 *
 * FAIL-CLOSED + PRIVACY-MINIMIZED (issue #875): the `meterKey` MUST resolve
 * against the #874 single source (`isKnownMeterKey`) or the append is rejected
 * (`unknown_meter`); the payload is an exact numeric `quantity` plus a bounded
 * map of ADMITTED dimensions only — NEVER a raw request body, document, secret,
 * or arbitrary JSON. Identity binds (tenant, producer, meter, sourceEventId,
 * sourceVersion): a duplicate producer event is deduplicated (counted once).
 * `tenantId` is trusted from the CALLER's own tenant context — a producer can
 * never submit usage for another tenant.
 */
export type UsageAppendInput = {
  /** Must resolve to a known #874 meter (fail-closed otherwise). */
  meterKey: string;
  /** The producing module/subsystem key, `^[a-z][a-z0-9_]*$`. */
  producer: string;
  /** The producer's own idempotent event id (dedup identity). */
  sourceEventId: string;
  /** Defaults to `1`. Part of the idempotency identity. */
  sourceVersion?: number;
  /** Exact non-negative integer sample (a decrease is a signed correction, never a negative event). */
  quantity: number;
  /** When the usage occurred (producer-supplied); accepted late/out-of-order. */
  eventTime: string | Date;
  /** REQUIRED for a `unique_count` meter (the pseudonymous distinct key); must be null/absent otherwise. */
  uniqueDimension?: string | null;
  /** A small bounded map of admitted numeric/short-scalar dimensions (no PII, no payloads). */
  dimensions?: Record<string, string | number>;
  correlationId?: string | null;
  actorTenantUserId?: string | null;
};

export type UsageAppendError = { field: string; message: string };

export type UsageAppendResult =
  | {
      ok: true;
      eventId: string;
      ingestSeq: number;
      /** `true` when a prior event with the identical idempotency identity already existed (counted once). */
      deduplicated: boolean;
    }
  | { ok: false; reason: "unknown_meter" }
  | { ok: false; reason: "validation"; errors: UsageAppendError[] };

/**
 * `tx` MUST be the caller's own business transaction — the adapter writes the
 * immutable usage-event row inside it so source state and usage commit
 * atomically. The port never opens its own transaction and never calls a
 * provider.
 */
export type UsageAppendPort = (
  tx: Bun.SQL,
  tenantId: string,
  input: UsageAppendInput
) => Promise<UsageAppendResult>;
