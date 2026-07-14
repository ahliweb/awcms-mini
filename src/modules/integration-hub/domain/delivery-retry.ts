/**
 * Outbound delivery retry policy (Issue #754). Same exponential-backoff
 * SHAPE as `email/domain/email-retry.ts` (this repo's established pattern
 * for a NETWORK-provider-backed outbox, distinct from `domain_event_
 * runtime/domain/delivery-retry.ts`'s DB-only-handler variant, which
 * reuses `classifyError` from the shared worker runner instead — outbound
 * subscription delivery is a real HTTP call, so retryability is decided by
 * the HTTP outcome itself, exactly like `EmailProvider.send()`'s own
 * `retryable` flag).
 */
export const INTEGRATION_HUB_MAX_RETRY_DELAY_MINUTES = 60;

export type OutboundDeliveryRetryEvaluation =
  { eligible: true; nextAttemptAt: Date } | { eligible: false };

export function evaluateOutboundDeliveryRetry(
  attemptCount: number,
  maxAttempts: number,
  retryable: boolean,
  now: Date
): OutboundDeliveryRetryEvaluation {
  if (!retryable || attemptCount >= maxAttempts) {
    return { eligible: false };
  }

  const delayMinutes = Math.min(
    2 ** (attemptCount - 1),
    INTEGRATION_HUB_MAX_RETRY_DELAY_MINUTES
  );

  return {
    eligible: true,
    nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000)
  };
}
