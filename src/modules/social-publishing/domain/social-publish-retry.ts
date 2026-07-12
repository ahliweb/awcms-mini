/**
 * Retry/backoff evaluation for `awcms_mini_social_publish_jobs` (Issue
 * #643). Same exponential-backoff SHAPE as
 * `sync-storage/domain/object-queue.ts`'s `evaluateObjectRetry` (not
 * reimplemented from scratch, but not literally reused either — jobs here
 * are per-tenant business rows with their own `max_attempts` column, not a
 * fixed module-wide constant, since an operator may want a different retry
 * budget for a job than the sync queue's fixed 5), same
 * `Math.min(2 ** attemptCount, capMinutes)` formula, pure/timer-free (every
 * function takes `now: Date` explicitly).
 */
export type SocialPublishRetryEvaluation =
  { eligible: true; nextAttemptAt: Date } | { eligible: false };

export const SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES = 240;

/**
 * `attemptCount` is the count AFTER the attempt that just failed (i.e. the
 * caller increments before calling this, same convention
 * `evaluateObjectRetry` uses with its own `retryCount` parameter).
 */
export function evaluateSocialPublishRetry(
  attemptCount: number,
  maxAttempts: number,
  now: Date
): SocialPublishRetryEvaluation {
  if (attemptCount >= maxAttempts) {
    return { eligible: false };
  }

  const delayMinutes = Math.min(
    2 ** attemptCount,
    SOCIAL_PUBLISH_MAX_RETRY_DELAY_MINUTES
  );

  return {
    eligible: true,
    nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000)
  };
}

/**
 * Rate-limit backoff — same shape but seeded from the provider's own
 * `retryAfterSeconds` hint when present (never less than the exponential
 * floor, so a provider reporting an implausibly short `retryAfterSeconds`
 * cannot force a tight retry loop).
 */
export function evaluateSocialPublishRateLimitRetry(
  attemptCount: number,
  maxAttempts: number,
  now: Date,
  retryAfterSeconds: number | undefined
): SocialPublishRetryEvaluation {
  const exponential = evaluateSocialPublishRetry(
    attemptCount,
    maxAttempts,
    now
  );

  if (!exponential.eligible) {
    return exponential;
  }

  if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) {
    return exponential;
  }

  const providerHinted = new Date(now.getTime() + retryAfterSeconds * 1000);

  return {
    eligible: true,
    nextAttemptAt:
      providerHinted.getTime() > exponential.nextAttemptAt.getTime()
        ? providerHinted
        : exponential.nextAttemptAt
  };
}
