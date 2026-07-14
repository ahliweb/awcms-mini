/**
 * Outbound subscription delivery dispatcher (Issue #754). Three-phase
 * pattern (ADR-0006 — never call a provider inside a DB transaction),
 * mirroring `email/application/email-dispatch.ts` exactly:
 *
 * 1. CLAIM — one short transaction flips eligible `pending`/`retry_wait`
 *    rows to a transient `sending` status (`FOR UPDATE SKIP LOCKED`),
 *    reusing `next_attempt_at` as the claim lease expiry.
 * 2. SEND — for each claimed row, resolves the subscription's
 *    `target_url`/`target_headers`/`secret_reference`, builds the
 *    outbound payload from the source domain event, and calls
 *    `infrastructure/outbound-http-client.ts`'s `deliverOutboundWebhook`
 *    *outside* any transaction (SSRF-validated at this point too, defense
 *    in depth against the target having changed DNS since subscription
 *    creation).
 * 3. FINALIZE — one short transaction per row flips `sending` to
 *    `delivered`, or (on failure) to `retry_wait` with backoff
 *    (`domain/delivery-retry.ts`) or `dead_letter` once attempts are
 *    exhausted or the failure is non-retryable. Every attempt is recorded
 *    in `awcms_mini_integration_delivery_attempts`; adapter health is
 *    updated after every attempt.
 *
 * Invoked by `scripts/integration-hub-outbound-dispatch.ts`
 * (`bun run integration-hub:outbound:dispatch`), one tenant at a time —
 * NOT a public HTTP endpoint, same "trusted internal worker only"
 * boundary as `email-dispatch.ts`/`object-dispatch.ts`.
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenant } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { evaluateOutboundDeliveryRetry } from "../domain/delivery-retry";
import { isPrivateTargetsAllowed } from "../domain/integration-hub-config";
import {
  applyHealthFailure,
  applyHealthSuccess
} from "../domain/adapter-health";
import { deliverOutboundWebhook } from "../infrastructure/outbound-http-client";
import { resolveSecretReference } from "./secret-resolver";

const MODULE_KEY = "integration_hub";

export const INTEGRATION_HUB_OUTBOUND_DISPATCH_DEFAULT_LIMIT = 25;
export const INTEGRATION_HUB_OUTBOUND_DISPATCH_LEASE_MINUTES = 2;

type ClaimedDeliveryRow = {
  id: string;
  subscription_id: string;
  source_event_id: string;
  event_type: string;
  attempt_count: string | number;
  max_attempts: string | number;
  correlation_id: string | null;
};

type SubscriptionRow = {
  target_url: string;
  target_headers: Record<string, string>;
  secret_reference: string | null;
  timeout_ms: number;
  status: string;
};

export type DispatchOutboundQueueOptions = {
  limit?: number;
  now?: Date;
  correlationId?: string;
  env?: NodeJS.ProcessEnv;
};

export type DispatchOutboundQueueResult = {
  /** Same value as `claimed` — satisfies `src/lib/jobs/batching.ts`'s `BatchPassResult` shape so this can drive `iterateTenantsInBatches` (the loop stops once a pass claims 0 rows). */
  count: number;
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skippedNoSubscription: number;
};

async function claimEligibleDeliveries(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<ClaimedDeliveryRow[]> {
  const leaseExpiry = new Date(
    now.getTime() + INTEGRATION_HUB_OUTBOUND_DISPATCH_LEASE_MINUTES * 60_000
  );

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = await tx`
        UPDATE awcms_mini_integration_outbound_deliveries
        SET status = 'sending', next_attempt_at = ${leaseExpiry}
        WHERE id IN (
          SELECT id FROM awcms_mini_integration_outbound_deliveries
          WHERE tenant_id = ${tenantId}
            AND status IN ('pending', 'retry_wait')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, subscription_id, source_event_id, event_type, attempt_count, max_attempts, correlation_id
      `;

      return rows as unknown as ClaimedDeliveryRow[];
    },
    { workClass: "background_sync" }
  );
}

async function fetchSubscription(
  sql: Bun.SQL,
  tenantId: string,
  subscriptionId: string
): Promise<SubscriptionRow | null> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT target_url, target_headers, secret_reference, timeout_ms, status
        FROM awcms_mini_integration_subscriptions
        WHERE tenant_id = ${tenantId} AND id = ${subscriptionId} AND deleted_at IS NULL
      `) as SubscriptionRow[];

      return rows[0] ?? null;
    },
    { workClass: "background_sync" }
  );
}

async function fetchSourceEventPayload(
  sql: Bun.SQL,
  tenantId: string,
  eventId: string
): Promise<Record<string, unknown> | null> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT payload FROM awcms_mini_domain_events
        WHERE tenant_id = ${tenantId} AND id = ${eventId}
      `) as { payload: Record<string, unknown> }[];

      return rows[0]?.payload ?? null;
    },
    { workClass: "background_sync" }
  );
}

async function recordAttempt(
  sql: Bun.SQL,
  tenantId: string,
  deliveryId: string,
  attemptNo: number,
  outcome: "success" | "failure",
  httpStatus: number | null,
  responseSnippet: string | null,
  errorMessage: string | null
): Promise<void> {
  await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_mini_integration_delivery_attempts
        (tenant_id, delivery_id, attempt_no, outcome, http_status, response_snippet, error_message)
      VALUES (${tenantId}, ${deliveryId}, ${attemptNo}, ${outcome}, ${httpStatus}, ${responseSnippet}, ${errorMessage})
    `,
    { workClass: "background_sync" }
  );
}

async function finalizeDelivered(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  httpStatus: number
): Promise<void> {
  await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_mini_integration_outbound_deliveries
      SET status = 'delivered', last_http_status = ${httpStatus}, next_attempt_at = null, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );
}

async function finalizeFailure(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  attemptCount: number,
  maxAttempts: number,
  retryable: boolean,
  now: Date,
  errorMessage: string,
  httpStatus: number | null
): Promise<{ eligible: boolean }> {
  const evaluation = evaluateOutboundDeliveryRetry(
    attemptCount,
    maxAttempts,
    retryable,
    now
  );

  if (evaluation.eligible) {
    await withTenant(
      sql,
      tenantId,
      (tx) => tx`
        UPDATE awcms_mini_integration_outbound_deliveries
        SET status = 'retry_wait', attempt_count = ${attemptCount}, next_attempt_at = ${evaluation.nextAttemptAt},
            last_error = ${errorMessage}, last_http_status = ${httpStatus}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
      `,
      { workClass: "background_sync" }
    );

    return { eligible: true };
  }

  await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_mini_integration_outbound_deliveries
      SET status = 'dead_letter', attempt_count = ${attemptCount}, next_attempt_at = null,
          last_error = ${errorMessage}, last_http_status = ${httpStatus}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );

  return { eligible: false };
}

async function upsertAdapterHealth(
  sql: Bun.SQL,
  tenantId: string,
  adapterKey: string,
  success: boolean
): Promise<void> {
  await withTenant(
    sql,
    tenantId,
    async (tx) => {
      const existingRows = (await tx`
        SELECT state, consecutive_failures, consecutive_successes
        FROM awcms_mini_integration_adapter_health
        WHERE tenant_id = ${tenantId} AND adapter_key = ${adapterKey} AND direction = 'outbound'
      `) as {
        state: string;
        consecutive_failures: number;
        consecutive_successes: number;
      }[];

      const current = existingRows[0]
        ? {
            state: existingRows[0].state as "up" | "degraded" | "down",
            consecutiveFailures: Number(existingRows[0].consecutive_failures),
            consecutiveSuccesses: Number(existingRows[0].consecutive_successes)
          }
        : {
            state: "up" as const,
            consecutiveFailures: 0,
            consecutiveSuccesses: 0
          };

      const next = success
        ? applyHealthSuccess(current)
        : applyHealthFailure(current);

      await tx`
        INSERT INTO awcms_mini_integration_adapter_health
          (tenant_id, adapter_key, direction, state, consecutive_failures,
           consecutive_successes, last_success_at, last_failure_at, last_checked_at, updated_at)
        VALUES (
          ${tenantId}, ${adapterKey}, 'outbound', ${next.state}, ${next.consecutiveFailures},
          ${next.consecutiveSuccesses}, ${success ? new Date() : null}, ${success ? null : new Date()},
          now(), now()
        )
        ON CONFLICT (tenant_id, adapter_key, direction) DO UPDATE SET
          state = EXCLUDED.state,
          consecutive_failures = EXCLUDED.consecutive_failures,
          consecutive_successes = EXCLUDED.consecutive_successes,
          last_success_at = COALESCE(EXCLUDED.last_success_at, awcms_mini_integration_adapter_health.last_success_at),
          last_failure_at = COALESCE(EXCLUDED.last_failure_at, awcms_mini_integration_adapter_health.last_failure_at),
          last_checked_at = now(),
          updated_at = now()
      `;
    },
    { workClass: "background_sync" }
  );
}

const GENERIC_HTTP_ADAPTER_KEY = "generic_http_webhook";

/**
 * Dispatches one batch (default `INTEGRATION_HUB_OUTBOUND_DISPATCH_
 * DEFAULT_LIMIT` rows) of due outbound deliveries for a single tenant.
 * Safe to call repeatedly (claim-lease pattern); the CLI script loops per
 * tenant to drain a larger backlog.
 */
export async function dispatchOutboundQueue(
  sql: Bun.SQL,
  tenantId: string,
  options: DispatchOutboundQueueOptions = {}
): Promise<DispatchOutboundQueueResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const limit =
    options.limit ?? INTEGRATION_HUB_OUTBOUND_DISPATCH_DEFAULT_LIMIT;
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const allowPrivateTargets = isPrivateTargetsAllowed(env);

  const result: DispatchOutboundQueueResult = {
    count: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    skippedNoSubscription: 0
  };

  const claimed = await claimEligibleDeliveries(sql, tenantId, now, limit);
  result.claimed = claimed.length;
  result.count = claimed.length;

  if (claimed.length === 0) {
    return result;
  }

  log("info", "integration_hub.outbound_dispatch.claimed", {
    correlationId,
    tenantId,
    moduleKey: MODULE_KEY,
    count: claimed.length
  });

  for (const entry of claimed) {
    const attemptCount = Number(entry.attempt_count) + 1;
    const maxAttempts = Number(entry.max_attempts);
    const deliveryCorrelationId = entry.correlation_id ?? correlationId;

    const subscription = await fetchSubscription(
      sql,
      tenantId,
      entry.subscription_id
    );

    if (!subscription || subscription.status !== "active") {
      await finalizeFailure(
        sql,
        tenantId,
        entry.id,
        attemptCount,
        maxAttempts,
        false,
        now,
        "Subscription no longer exists or is not active.",
        null
      );
      result.skippedNoSubscription += 1;
      continue;
    }

    const breaker = getProviderCircuitBreaker(
      `integration-hub:subscription:${entry.subscription_id}`
    );

    if (!breaker.canAttempt(now)) {
      await finalizeFailure(
        sql,
        tenantId,
        entry.id,
        attemptCount,
        maxAttempts,
        true,
        now,
        "Circuit breaker open for this subscription's target.",
        null
      );
      result.retried += 1;
      continue;
    }

    const sourcePayload = await fetchSourceEventPayload(
      sql,
      tenantId,
      entry.source_event_id
    );

    let secretValue: string | null = null;

    if (subscription.secret_reference) {
      const resolution = resolveSecretReference(
        subscription.secret_reference,
        env
      );
      secretValue = resolution.ok ? resolution.value : null;
    }

    const deliveryResult = await deliverOutboundWebhook({
      url: subscription.target_url,
      headers: subscription.target_headers ?? {},
      body: JSON.stringify({
        eventType: entry.event_type,
        deliveryId: entry.id,
        payload: sourcePayload ?? {}
      }),
      timeoutMs: subscription.timeout_ms,
      secret: secretValue,
      allowPrivateTargets
    });

    if (deliveryResult.ok) {
      breaker.recordSuccess(now);
      await recordAttempt(
        sql,
        tenantId,
        entry.id,
        attemptCount,
        "success",
        deliveryResult.httpStatus,
        deliveryResult.responseSnippet,
        null
      );
      await finalizeDelivered(
        sql,
        tenantId,
        entry.id,
        deliveryResult.httpStatus
      );
      await upsertAdapterHealth(sql, tenantId, GENERIC_HTTP_ADAPTER_KEY, true);
      log("info", "integration_hub.outbound_dispatch.delivered", {
        correlationId: deliveryCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY
      });
      result.delivered += 1;
      continue;
    }

    breaker.recordFailure(now);
    await recordAttempt(
      sql,
      tenantId,
      entry.id,
      attemptCount,
      "failure",
      deliveryResult.httpStatus ?? null,
      null,
      deliveryResult.errorMessage
    );

    const finalized = await finalizeFailure(
      sql,
      tenantId,
      entry.id,
      attemptCount,
      maxAttempts,
      deliveryResult.retryable,
      now,
      deliveryResult.errorMessage,
      deliveryResult.httpStatus ?? null
    );
    await upsertAdapterHealth(sql, tenantId, GENERIC_HTTP_ADAPTER_KEY, false);

    if (finalized.eligible) {
      log("warning", "integration_hub.outbound_dispatch.retry_scheduled", {
        correlationId: deliveryCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY,
        attemptCount,
        errorCode: deliveryResult.errorCode
      });
      result.retried += 1;
    } else {
      log("error", "integration_hub.outbound_dispatch.dead_lettered", {
        correlationId: deliveryCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY,
        attemptCount,
        errorCode: deliveryResult.errorCode
      });
      result.deadLettered += 1;
    }
  }

  return result;
}
