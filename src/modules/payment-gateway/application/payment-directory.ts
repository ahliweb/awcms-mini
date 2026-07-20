/**
 * All `payment_gateway` database access (Issue #877). Every function runs inside
 * the CALLER's already tenant-scoped `tx` (or, for the bootstrap resolver, on the
 * raw `sql` BEFORE a tenant context exists). Concurrency-safe: intent/refund
 * writes row-lock (`FOR UPDATE`) then UPDATE with a status+version predicate;
 * webhook intake and payment allocation dedup via partial-unique + `ON CONFLICT`.
 * No `Promise.all` over a single `tx` (memory [[promise-all-on-single-tx-hang]]).
 */

export type ProviderAccountLookupRow = {
  provider_account_id: string;
  tenant_id: string;
  provider_key: string;
  provider_account_ref: string;
  account_status: string;
  signing_secret_ref: string;
  endpoint_host: string;
  callback_host: string | null;
  webhook_tolerance_seconds: number;
  max_webhook_body_bytes: number;
  tenant_status: string;
};

export type ProviderAccountRow = {
  id: string;
  tenant_id: string;
  provider_key: string;
  provider_account_ref: string;
  display_name: string | null;
  status: string;
  signing_secret_ref: string;
  endpoint_host: string;
  callback_host: string | null;
  webhook_tolerance_seconds: number;
  max_webhook_body_bytes: number;
};

export type IntentRow = {
  id: string;
  tenant_id: string;
  provider_account_id: string;
  provider_key: string;
  invoice_id: string;
  subscription_id: string | null;
  currency: string;
  amount_minor: string;
  status: string;
  previous_status: string | null;
  version: number;
  provider_session_ref: string | null;
  checkout_url: string | null;
  last_event_sequence: string;
  failure_class: string | null;
  expires_at: string | null;
  settled_at: string | null;
};

export type RefundRow = {
  id: string;
  tenant_id: string;
  intent_id: string;
  invoice_id: string | null;
  currency: string;
  amount_minor: string;
  status: string;
  previous_status: string | null;
  version: number;
  provider_refund_ref: string | null;
  result_class: string | null;
};

export type OutboxRow = {
  id: string;
  tenant_id: string;
  provider_account_id: string;
  intent_id: string | null;
  refund_id: string | null;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  correlation_id: string | null;
};

// -------------------------------------------------------------------------
// Bootstrap resolver (BEFORE any tenant context — SECURITY DEFINER, sql/093)
// -------------------------------------------------------------------------

export async function resolveProviderAccountLookup(
  sql: Bun.SQL,
  accountId: string
): Promise<ProviderAccountLookupRow | null> {
  const rows = (await sql`
    SELECT * FROM awcms_mini_resolve_payment_gateway_account_lookup(${accountId})
  `) as ProviderAccountLookupRow[];
  return rows[0] ?? null;
}

// -------------------------------------------------------------------------
// Provider accounts
// -------------------------------------------------------------------------

export async function loadProviderAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<ProviderAccountRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, provider_account_ref, display_name, status,
           signing_secret_ref, endpoint_host, callback_host,
           webhook_tolerance_seconds, max_webhook_body_bytes
    FROM awcms_mini_payment_gateway_provider_accounts
    WHERE tenant_id = ${tenantId} AND id = ${accountId}
  `) as ProviderAccountRow[];
  return rows[0] ?? null;
}

export async function findProviderAccountByBinding(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  providerAccountRef: string
): Promise<ProviderAccountRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, provider_key, provider_account_ref, display_name, status,
           signing_secret_ref, endpoint_host, callback_host,
           webhook_tolerance_seconds, max_webhook_body_bytes
    FROM awcms_mini_payment_gateway_provider_accounts
    WHERE tenant_id = ${tenantId} AND provider_key = ${providerKey}
      AND provider_account_ref = ${providerAccountRef}
  `) as ProviderAccountRow[];
  return rows[0] ?? null;
}

export async function insertProviderAccount(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    providerKey: string;
    providerAccountRef: string;
    displayName: string | null;
    status: string;
    signingSecretRef: string;
    endpointHost: string;
    callbackHost: string | null;
    webhookToleranceSeconds: number;
    maxWebhookBodyBytes: number;
    reason: string | null;
    actor: string | null;
  }
): Promise<ProviderAccountRow> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_provider_accounts
      (tenant_id, provider_key, provider_account_ref, display_name, status,
       signing_secret_ref, endpoint_host, callback_host, webhook_tolerance_seconds,
       max_webhook_body_bytes, reason, created_by, updated_by)
    VALUES (
      ${input.tenantId}, ${input.providerKey}, ${input.providerAccountRef},
      ${input.displayName}, ${input.status}, ${input.signingSecretRef},
      ${input.endpointHost}, ${input.callbackHost}, ${input.webhookToleranceSeconds},
      ${input.maxWebhookBodyBytes}, ${input.reason}, ${input.actor}, ${input.actor}
    )
    RETURNING id, tenant_id, provider_key, provider_account_ref, display_name, status,
              signing_secret_ref, endpoint_host, callback_host,
              webhook_tolerance_seconds, max_webhook_body_bytes
  `) as ProviderAccountRow[];
  return rows[0]!;
}

export async function updateProviderAccount(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    accountId: string;
    displayName: string | null;
    status: string;
    signingSecretRef: string;
    endpointHost: string;
    callbackHost: string | null;
    webhookToleranceSeconds: number;
    maxWebhookBodyBytes: number;
    reason: string | null;
    actor: string | null;
  }
): Promise<ProviderAccountRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_payment_gateway_provider_accounts
    SET display_name = ${input.displayName},
        status = ${input.status},
        signing_secret_ref = ${input.signingSecretRef},
        endpoint_host = ${input.endpointHost},
        callback_host = ${input.callbackHost},
        webhook_tolerance_seconds = ${input.webhookToleranceSeconds},
        max_webhook_body_bytes = ${input.maxWebhookBodyBytes},
        reason = ${input.reason},
        updated_by = ${input.actor},
        updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND id = ${input.accountId}
    RETURNING id, tenant_id, provider_key, provider_account_ref, display_name, status,
              signing_secret_ref, endpoint_host, callback_host,
              webhook_tolerance_seconds, max_webhook_body_bytes
  `) as ProviderAccountRow[];
  return rows[0] ?? null;
}

// -------------------------------------------------------------------------
// Payment intents
// -------------------------------------------------------------------------

export async function loadIntentForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  intentId: string
): Promise<IntentRow | null> {
  const rows = (await tx`
    SELECT *
    FROM awcms_mini_payment_gateway_payment_intents
    WHERE tenant_id = ${tenantId} AND id = ${intentId}
    FOR UPDATE
  `) as IntentRow[];
  return rows[0] ?? null;
}

export async function loadIntentBySession(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  providerSessionRef: string
): Promise<IntentRow | null> {
  const rows = (await tx`
    SELECT *
    FROM awcms_mini_payment_gateway_payment_intents
    WHERE tenant_id = ${tenantId} AND provider_account_id = ${accountId}
      AND provider_session_ref = ${providerSessionRef}
    FOR UPDATE
  `) as IntentRow[];
  return rows[0] ?? null;
}

export async function findLiveIntentForInvoice(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<IntentRow | null> {
  const rows = (await tx`
    SELECT *
    FROM awcms_mini_payment_gateway_payment_intents
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
      AND status IN ('initiated', 'pending')
    ORDER BY created_at DESC
    LIMIT 1
  `) as IntentRow[];
  return rows[0] ?? null;
}

/** Insert a new initiated intent. Returns null on the live-invoice partial-unique conflict (a concurrent live charge already exists). */
export async function insertIntent(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    providerAccountId: string;
    providerKey: string;
    invoiceId: string;
    subscriptionId: string | null;
    currency: string;
    amountMinor: number;
    expiresAt: string | null;
    reason: string;
    correlationId: string | null;
    actor: string | null;
  }
): Promise<IntentRow | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_payment_intents
      (tenant_id, provider_account_id, provider_key, invoice_id, subscription_id,
       currency, amount_minor, status, reason, expires_at, correlation_id,
       created_by, updated_by, actor)
    VALUES (
      ${input.tenantId}, ${input.providerAccountId}, ${input.providerKey},
      ${input.invoiceId}, ${input.subscriptionId}, ${input.currency},
      ${input.amountMinor}, 'initiated', ${input.reason}, ${input.expiresAt},
      ${input.correlationId}, ${input.actor}, ${input.actor}, ${input.actor}
    )
    ON CONFLICT (tenant_id, invoice_id) WHERE status IN ('initiated', 'pending')
    DO NOTHING
    RETURNING *
  `) as IntentRow[];
  return rows[0] ?? null;
}

/**
 * Advance an intent's status along the forward-legal state machine with an
 * optimistic-concurrency guard (`version` predicate). Returns null on a
 * concurrent version change (the caller maps to 409). Optionally sets the
 * provider session ref / checkout url / failure class / event sequence / settled
 * time in the SAME commit.
 */
export async function advanceIntentStatus(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    intentId: string;
    fromStatus: string;
    fromVersion: number;
    toStatus: string;
    providerSessionRef?: string | null;
    checkoutUrl?: string | null;
    failureClass?: string | null;
    eventSequence?: number | null;
    settledAt?: string | null;
    actor: string | null;
  }
): Promise<IntentRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_payment_gateway_payment_intents
    SET status = ${input.toStatus},
        previous_status = ${input.fromStatus},
        version = version + 1,
        provider_session_ref = COALESCE(${input.providerSessionRef ?? null}, provider_session_ref),
        checkout_url = COALESCE(${input.checkoutUrl ?? null}, checkout_url),
        failure_class = ${input.failureClass ?? null},
        last_event_sequence = GREATEST(last_event_sequence, ${input.eventSequence ?? 0}),
        settled_at = COALESCE(${input.settledAt ?? null}, settled_at),
        updated_by = ${input.actor},
        updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND id = ${input.intentId}
      AND status = ${input.fromStatus} AND version = ${input.fromVersion}
    RETURNING *
  `) as IntentRow[];
  return rows[0] ?? null;
}

/** Record the last-applied provider event sequence without a status change (out-of-order/duplicate bookkeeping). */
export async function bumpIntentEventSequence(
  tx: Bun.SQL,
  tenantId: string,
  intentId: string,
  sequence: number
): Promise<void> {
  await tx`
    UPDATE awcms_mini_payment_gateway_payment_intents
    SET last_event_sequence = GREATEST(last_event_sequence, ${sequence}), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${intentId}
  `;
}

/** Intents eligible for reconciliation: non-terminal with a provider session ref (a provider status can be queried). Bounded. */
export async function listReconcilableIntents(
  tx: Bun.SQL,
  tenantId: string,
  limit: number
): Promise<IntentRow[]> {
  return (await tx`
    SELECT *
    FROM awcms_mini_payment_gateway_payment_intents
    WHERE tenant_id = ${tenantId}
      AND status IN ('initiated', 'pending')
      AND provider_session_ref IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `) as IntentRow[];
}

/** Live intents whose window has elapsed without a settling outcome — the expire sweep advances them to `expired`. Bounded. */
export async function listExpirableIntents(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<IntentRow[]> {
  return (await tx`
    SELECT *
    FROM awcms_mini_payment_gateway_payment_intents
    WHERE tenant_id = ${tenantId}
      AND status IN ('initiated', 'pending')
      AND expires_at IS NOT NULL
      AND expires_at <= ${now.toISOString()}
    ORDER BY expires_at ASC
    LIMIT ${limit}
  `) as IntentRow[];
}

// -------------------------------------------------------------------------
// Webhook inbox / normalized events / processing attempts
// -------------------------------------------------------------------------

/** Insert a signature-VALID delivery. Returns null on the durable anti-replay conflict (exactly-once: a replay is a clean no-op). */
export async function insertWebhookDelivery(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    providerAccountId: string;
    providerKey: string;
    providerEventId: string;
    eventTimestampSeconds: number | null;
    contentType: string | null;
    rawBodySha256: string;
    rawBodySize: number;
    maskedSnippet: string | null;
    correlationId: string | null;
  }
): Promise<{ id: string } | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_webhook_inbox
      (tenant_id, provider_account_id, provider_key, provider_event_id, signature_valid,
       event_timestamp_seconds, content_type, raw_body_sha256, raw_body_size,
       masked_snippet, status, correlation_id)
    VALUES (
      ${input.tenantId}, ${input.providerAccountId}, ${input.providerKey},
      ${input.providerEventId}, true, ${input.eventTimestampSeconds}, ${input.contentType},
      ${input.rawBodySha256}, ${input.rawBodySize}, ${input.maskedSnippet}, 'received',
      ${input.correlationId}
    )
    ON CONFLICT (tenant_id, provider_account_id, provider_event_id) DO NOTHING
    RETURNING id
  `) as { id: string }[];
  return rows[0] ?? null;
}

/** Persist a REJECTED delivery (fresh per-attempt id so a flood never collides with a legitimate delivery). */
export async function insertRejectedWebhookDelivery(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    providerAccountId: string;
    providerKey: string;
    freshEventId: string;
    reason: string;
    contentType: string | null;
    rawBodySha256: string;
    rawBodySize: number;
    correlationId: string | null;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_payment_gateway_webhook_inbox
      (tenant_id, provider_account_id, provider_key, provider_event_id, signature_valid,
       verification_failure_reason, content_type, raw_body_sha256, raw_body_size,
       status, correlation_id)
    VALUES (
      ${input.tenantId}, ${input.providerAccountId}, ${input.providerKey},
      ${input.freshEventId}, false, ${input.reason}, ${input.contentType},
      ${input.rawBodySha256}, ${input.rawBodySize}, 'rejected', ${input.correlationId}
    )
  `;
}

export async function markWebhookNormalized(
  tx: Bun.SQL,
  tenantId: string,
  inboxId: string,
  normalizedEventId: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_payment_gateway_webhook_inbox
    SET status = 'normalized', normalized_event_id = ${normalizedEventId}
    WHERE tenant_id = ${tenantId} AND id = ${inboxId} AND status = 'received'
  `;
}

export async function insertNormalizedEvent(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    webhookInboxId: string;
    intentId: string | null;
    providerKey: string;
    providerSessionRef: string | null;
    normalizedStatus: string;
    providerStatusRaw: string | null;
    providerSequence: number;
    currency: string | null;
    amountMinor: number | null;
    correlationId: string | null;
  }
): Promise<{ id: string }> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_normalized_events
      (tenant_id, webhook_inbox_id, intent_id, provider_key, provider_session_ref,
       normalized_status, provider_status_raw, provider_sequence, currency, amount_minor,
       correlation_id)
    VALUES (
      ${input.tenantId}, ${input.webhookInboxId}, ${input.intentId}, ${input.providerKey},
      ${input.providerSessionRef}, ${input.normalizedStatus}, ${input.providerStatusRaw},
      ${input.providerSequence}, ${input.currency}, ${input.amountMinor}, ${input.correlationId}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!;
}

export async function insertProcessingAttempt(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    normalizedEventId: string;
    intentId: string | null;
    outcome: string;
    fromStatus: string | null;
    toStatus: string | null;
    detail: string | null;
    correlationId: string | null;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_payment_gateway_processing_attempts
      (tenant_id, normalized_event_id, intent_id, outcome, from_status, to_status,
       detail, correlation_id)
    VALUES (
      ${input.tenantId}, ${input.normalizedEventId}, ${input.intentId}, ${input.outcome},
      ${input.fromStatus}, ${input.toStatus}, ${input.detail}, ${input.correlationId}
    )
  `;
}

// -------------------------------------------------------------------------
// Outbox (provider-work dispatch queue)
// -------------------------------------------------------------------------

export async function insertOutbox(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    providerAccountId: string;
    intentId: string | null;
    refundId: string | null;
    kind: string;
    payload: Record<string, unknown>;
    correlationId: string | null;
  }
): Promise<{ id: string }> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_outbox
      (tenant_id, provider_account_id, intent_id, refund_id, kind, payload, correlation_id)
    VALUES (
      ${input.tenantId}, ${input.providerAccountId}, ${input.intentId}, ${input.refundId},
      ${input.kind}, ${input.payload}, ${input.correlationId}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!;
}

/** Atomically claim ONE due outbox row (pending/failed, next_attempt_at <= now), marking it in_flight. Row-locked, SKIP LOCKED — multi-worker safe. */
export async function claimNextOutbox(
  tx: Bun.SQL,
  tenantId: string,
  holder: string,
  now: Date
): Promise<OutboxRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_payment_gateway_outbox
    SET status = 'in_flight', claimed_by = ${holder}, claimed_at = ${now.toISOString()},
        attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM awcms_mini_payment_gateway_outbox
      WHERE tenant_id = ${tenantId} AND status IN ('pending', 'failed')
        AND next_attempt_at <= ${now.toISOString()}
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, tenant_id, provider_account_id, intent_id, refund_id, kind, status,
              attempts, max_attempts, payload, correlation_id
  `) as OutboxRow[];
  return rows[0] ?? null;
}

export async function finalizeOutbox(
  tx: Bun.SQL,
  tenantId: string,
  outboxId: string,
  status: "succeeded" | "failed" | "dead",
  nextAttemptAt: Date | null,
  lastErrorClass: string | null
): Promise<void> {
  await tx`
    UPDATE awcms_mini_payment_gateway_outbox
    SET status = ${status},
        next_attempt_at = COALESCE(${nextAttemptAt ? nextAttemptAt.toISOString() : null}, next_attempt_at),
        last_error_class = ${lastErrorClass},
        claimed_by = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${outboxId}
  `;
}

/**
 * Defer an outbox row WITHOUT consuming a retry attempt — the circuit-breaker-OPEN
 * path. `claimNextOutbox` already incremented `attempts` when it claimed the row,
 * but a circuit-open deferral is NOT the row's own failure, so we hand the attempt
 * back (`GREATEST(attempts - 1, 0)`). This prevents both a premature DLQ (a run of
 * circuit-open passes must never dead-letter a row that never actually failed) and
 * an `attempts > max_attempts` CHECK violation on a later claim.
 */
export async function deferOutboxAttempt(
  tx: Bun.SQL,
  tenantId: string,
  outboxId: string,
  nextAttemptAt: Date,
  lastErrorClass: string | null
): Promise<void> {
  await tx`
    UPDATE awcms_mini_payment_gateway_outbox
    SET status = 'failed',
        next_attempt_at = ${nextAttemptAt.toISOString()},
        attempts = GREATEST(attempts - 1, 0),
        last_error_class = ${lastErrorClass},
        claimed_by = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${outboxId}
  `;
}

/** Reset a DLQ (dead) outbox row to pending for a manual retry (idempotent — no-op if not dead). Returns true iff a row was reset. */
export async function retryDeadOutbox(
  tx: Bun.SQL,
  tenantId: string,
  outboxId: string,
  now: Date
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_payment_gateway_outbox
    SET status = 'pending', next_attempt_at = ${now.toISOString()}, attempts = 0, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${outboxId} AND status = 'dead'
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

// -------------------------------------------------------------------------
// Refunds
// -------------------------------------------------------------------------

export async function loadRefundForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  refundId: string
): Promise<RefundRow | null> {
  const rows = (await tx`
    SELECT *
    FROM awcms_mini_payment_gateway_refunds
    WHERE tenant_id = ${tenantId} AND id = ${refundId}
    FOR UPDATE
  `) as RefundRow[];
  return rows[0] ?? null;
}

/**
 * Insert a new `requested` refund. Returns null on the LIVE-refund partial-unique
 * conflict (`(tenant_id, intent_id) WHERE status IN ('requested','pending')`) — a
 * concurrent live refund already exists for this intent, so this request is a
 * clean no-op the caller maps to 409 (over-refund/double-refund guard, sql/093).
 */
export async function insertRefund(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    intentId: string;
    invoiceId: string | null;
    currency: string;
    amountMinor: number;
    reason: string;
    correlationId: string | null;
    actor: string | null;
  }
): Promise<RefundRow | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_refunds
      (tenant_id, intent_id, invoice_id, currency, amount_minor, status, reason,
       correlation_id, requested_by, created_by, updated_by)
    VALUES (
      ${input.tenantId}, ${input.intentId}, ${input.invoiceId}, ${input.currency},
      ${input.amountMinor}, 'requested', ${input.reason}, ${input.correlationId},
      ${input.actor}, ${input.actor}, ${input.actor}
    )
    ON CONFLICT (tenant_id, intent_id) WHERE status IN ('requested', 'pending')
    DO NOTHING
    RETURNING *
  `) as RefundRow[];
  return rows[0] ?? null;
}

/**
 * Sum of refund amounts that COUNT against the intent's captured amount — i.e.
 * live (`requested`/`pending`) OR already `succeeded` refunds — returned as an
 * EXACT decimal string. The caller compares it in BigInt (never Number()): the
 * SUM of many per-row `bigint` amounts can exceed Number.MAX_SAFE_INTEGER even
 * though each row is individually bounded, so a `Number(...)` compare could round.
 */
export async function sumCountedRefunds(
  tx: Bun.SQL,
  tenantId: string,
  intentId: string
): Promise<string> {
  const rows = (await tx`
    SELECT COALESCE(SUM(amount_minor), 0)::text AS total
    FROM awcms_mini_payment_gateway_refunds
    WHERE tenant_id = ${tenantId} AND intent_id = ${intentId}
      AND status IN ('requested', 'pending', 'succeeded')
  `) as { total: string }[];
  return rows[0]?.total ?? "0";
}

export async function advanceRefundStatus(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    refundId: string;
    fromStatus: string;
    fromVersion: number;
    toStatus: string;
    providerRefundRef?: string | null;
    resultClass?: string | null;
    resolvedAt?: string | null;
    actor: string | null;
  }
): Promise<RefundRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_payment_gateway_refunds
    SET status = ${input.toStatus},
        previous_status = ${input.fromStatus},
        version = version + 1,
        provider_refund_ref = COALESCE(${input.providerRefundRef ?? null}, provider_refund_ref),
        result_class = ${input.resultClass ?? null},
        resolved_at = COALESCE(${input.resolvedAt ?? null}, resolved_at),
        updated_by = ${input.actor},
        updated_at = now()
    WHERE tenant_id = ${input.tenantId} AND id = ${input.refundId}
      AND status = ${input.fromStatus} AND version = ${input.fromVersion}
    RETURNING *
  `) as RefundRow[];
  return rows[0] ?? null;
}

// -------------------------------------------------------------------------
// Reconciliation + provider health
// -------------------------------------------------------------------------

export async function insertReconciliation(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    intentId: string;
    providerStatus: string | null;
    localStatus: string;
    outcome: string;
    detail: string | null;
    correlationId: string | null;
    actor: string | null;
  }
): Promise<{ id: string }> {
  const rows = (await tx`
    INSERT INTO awcms_mini_payment_gateway_reconciliations
      (tenant_id, intent_id, provider_status, local_status, outcome, detail,
       correlation_id, created_by)
    VALUES (
      ${input.tenantId}, ${input.intentId}, ${input.providerStatus}, ${input.localStatus},
      ${input.outcome}, ${input.detail}, ${input.correlationId}, ${input.actor}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!;
}

export type HealthRow = {
  state: string;
  consecutive_failures: number;
  consecutive_successes: number;
  circuit_open_until: string | null;
};

export async function loadProviderHealth(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  direction: string
): Promise<HealthRow | null> {
  const rows = (await tx`
    SELECT state, consecutive_failures, consecutive_successes, circuit_open_until
    FROM awcms_mini_payment_gateway_provider_health
    WHERE tenant_id = ${tenantId} AND provider_account_id = ${accountId} AND direction = ${direction}
  `) as HealthRow[];
  return rows[0] ?? null;
}

export async function upsertProviderHealth(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    accountId: string;
    direction: string;
    state: string;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    circuitOpenUntil: string | null;
    success: boolean;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_payment_gateway_provider_health
      (tenant_id, provider_account_id, direction, state, consecutive_failures,
       consecutive_successes, circuit_open_until, last_success_at, last_failure_at,
       last_checked_at, updated_at)
    VALUES (
      ${input.tenantId}, ${input.accountId}, ${input.direction}, ${input.state},
      ${input.consecutiveFailures}, ${input.consecutiveSuccesses}, ${input.circuitOpenUntil},
      ${input.success ? new Date().toISOString() : null},
      ${input.success ? null : new Date().toISOString()}, now(), now()
    )
    ON CONFLICT (tenant_id, provider_account_id, direction) DO UPDATE SET
      state = EXCLUDED.state,
      consecutive_failures = EXCLUDED.consecutive_failures,
      consecutive_successes = EXCLUDED.consecutive_successes,
      circuit_open_until = EXCLUDED.circuit_open_until,
      last_success_at = COALESCE(EXCLUDED.last_success_at, awcms_mini_payment_gateway_provider_health.last_success_at),
      last_failure_at = COALESCE(EXCLUDED.last_failure_at, awcms_mini_payment_gateway_provider_health.last_failure_at),
      last_checked_at = now(),
      updated_at = now()
  `;
}
