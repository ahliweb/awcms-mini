/**
 * Single source of truth for this module's `dataLifecycle` descriptor keys
 * (Issue #932), shared by `module.ts` (the registry entries) and
 * `application/retention-purge.ts` (the delete path a legal hold is checked
 * against) — so the purge function and the key an operator places a hold on can
 * never drift, the same discipline
 * `usage-metering/module.ts`'s `USAGE_METERING_EVENTS_LIFECYCLE_KEY`
 * established.
 *
 * ONE key per table, because `data_lifecycle`'s registry is one descriptor per
 * table (unique `key` AND unique `tableName`, `lifecycle-registry.ts`). The
 * first three form a single evidence CHAIN
 * (`webhook_inbox` <- `normalized_events` <- `processing_attempts`), so
 * `WEBHOOK_EVIDENCE_CHAIN_LIFECYCLE_KEYS` groups them for the one place where
 * the chain must be treated as a unit: a legal hold on ANY link blocks the
 * purge of ALL THREE. That direction is deliberate and fail-closed — holding
 * the inbox while its derived events aged out would preserve a record nobody
 * can interpret, and holding the attempts while the inbox aged out would
 * preserve an outcome with no provenance.
 */
export const PAYMENT_GATEWAY_WEBHOOK_INBOX_LIFECYCLE_KEY =
  "payment_gateway.webhook_inbox";

export const PAYMENT_GATEWAY_NORMALIZED_EVENTS_LIFECYCLE_KEY =
  "payment_gateway.normalized_events";

export const PAYMENT_GATEWAY_PROCESSING_ATTEMPTS_LIFECYCLE_KEY =
  "payment_gateway.processing_attempts";

export const PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY =
  "payment_gateway.reconciliations";

/**
 * The outbound command queue (Issue #930 Wave 5).
 *
 * Independent of the evidence chain in both directions: the chain records what
 * a PROVIDER told us, the outbox records what WE asked a provider to do.
 * Neither references the other, so each is held and purged separately — a hold
 * on the evidence chain must not be read as covering the commands, nor as
 * excusing them.
 */
export const PAYMENT_GATEWAY_OUTBOX_LIFECYCLE_KEY = "payment_gateway.outbox";

/** The three links of the webhook evidence chain — a hold on any one blocks the purge of all of them. */
export const WEBHOOK_EVIDENCE_CHAIN_LIFECYCLE_KEYS = [
  PAYMENT_GATEWAY_WEBHOOK_INBOX_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_NORMALIZED_EVENTS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_PROCESSING_ATTEMPTS_LIFECYCLE_KEY
] as const;
