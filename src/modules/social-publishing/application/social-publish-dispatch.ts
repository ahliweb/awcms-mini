import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenant } from "../../../lib/database/tenant-context";
import { withTimeout } from "../../../lib/integration/timeout";
import { log } from "../../../lib/logging/logger";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  evaluateSocialPublishRateLimitRetry,
  evaluateSocialPublishRetry
} from "../domain/social-publish-retry";
import type {
  SocialProviderAdapter,
  SocialProviderPublishResult
} from "../domain/social-provider-adapter";
import { getSocialProviderAdapter } from "../infrastructure/social-provider-registry";
import {
  fetchSocialAccountTokenReferenceForDispatch,
  markSocialAccountNeedsReauth
} from "./social-account-directory";

/**
 * The outbox DISPATCHER (Issue #643 §Required behavior: "Use outbox/queue
 * pattern; never publish to external APIs inside the DB transaction that
 * publishes the article"; §Security notes: "External API calls must have
 * timeout, retry/backoff, and circuit breaker behavior"). Same 3-phase
 * CLAIM / CALL / FINALIZE shape `sync-storage/application/object-dispatch.ts`
 * established for its own outbox (ADR-0006):
 *
 * 1. CLAIM — one short transaction flips eligible `pending`/`approved` rows
 *    to `publishing` (`FOR UPDATE SKIP LOCKED`), reusing `next_attempt_at`
 *    as a claim "lease expiry" (same reuse-the-retry-column-as-lease
 *    convention `object-dispatch.ts` uses). Commits immediately — no
 *    provider call happens here.
 * 2. CALL — for each claimed row, resolves the provider adapter from the
 *    registry (`social-provider-registry.ts`, EMPTY in this foundation
 *    issue — every real call here is `provider_not_registered` until #644/
 *    #645/#646 register one) and, if the provider's circuit breaker allows
 *    it, calls `adapter.publish()` *outside* any transaction, wrapped in
 *    `withTimeout`.
 * 3. FINALIZE — one short transaction per row applies the outcome: success
 *    -> `published`; retryable failure with budget remaining -> back to
 *    `pending`/`approved` (whichever it required before) with exponential
 *    backoff (`next_attempt_at`); retries exhausted -> terminal `failed`;
 *    `rate_limited` -> same budget/backoff logic seeded from the
 *    provider's own `retryAfterSeconds` hint; `needs_reauth` -> terminal
 *    per-job (no further auto-retry) AND flips the linked account to
 *    `needs_reauth` (`markSocialAccountNeedsReauth`) so an operator knows
 *    to reconnect (Issue #643 §Required behavior: "Support reauthorization
 *    flow when token expires").
 */
const MODULE_KEY = "social_publishing";
export const SOCIAL_PUBLISH_DISPATCH_DEFAULT_LIMIT = 25;
export const SOCIAL_PUBLISH_DISPATCH_LEASE_MINUTES = 2;
export const SOCIAL_PUBLISH_CALL_TIMEOUT_MS = 10_000;

type ClaimedJobRow = {
  id: string;
  social_account_id: string;
  article_id: string;
  provider_key: string;
  requires_approval: boolean;
  // Defensively typed `string | number` (same convention
  // `object-dispatch.ts`'s `retry_count` uses) even though this repo's
  // Bun.SQL setup has been observed to decode a plain `integer RETURNING`
  // as a JS `number` — coerced via `Number(...)` at every arithmetic site
  // below so a decode-mode difference across environments can never turn
  // `attempt_count + 1` into string concatenation.
  attempt_count: string | number;
  max_attempts: string | number;
  title: string;
  excerpt_or_caption: string | null;
  canonical_url: string;
  image_url: string | null;
  correlation_id: string | null;
};

export type DispatchSocialPublishQueueOptions = {
  limit?: number;
  now?: Date;
  correlationId?: string;
  resolveAdapter?: (providerKey: string) => SocialProviderAdapter | undefined;
};

export type DispatchSocialPublishQueueResult = {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  rateLimited: number;
  needsReauth: number;
};

async function claimEligibleJobs(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<ClaimedJobRow[]> {
  const leaseExpiry = new Date(
    now.getTime() + SOCIAL_PUBLISH_DISPATCH_LEASE_MINUTES * 60_000
  );

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = await tx`
        UPDATE awcms_mini_social_publish_jobs
        SET status = 'publishing', next_attempt_at = ${leaseExpiry}
        WHERE id IN (
          SELECT id FROM awcms_mini_social_publish_jobs
          WHERE tenant_id = ${tenantId}
            AND status IN ('pending', 'approved')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, social_account_id, article_id, provider_key, requires_approval,
          attempt_count, max_attempts, title, excerpt_or_caption, canonical_url,
          image_url, correlation_id
      `;

      return rows as unknown as ClaimedJobRow[];
    },
    { workClass: "background_sync" }
  );
}

type FinalizeInput =
  | { kind: "published"; externalPostId: string; externalPostUrl: string }
  | {
      kind: "failed";
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
    }
  | {
      kind: "rate_limited";
      errorCode: string;
      errorMessage: string;
      retryAfterSeconds?: number;
    }
  | { kind: "needs_reauth"; errorCode: string; errorMessage: string };

async function finalizeJob(
  sql: Bun.SQL,
  tenantId: string,
  job: ClaimedJobRow,
  input: FinalizeInput,
  now: Date,
  correlationId: string | undefined
): Promise<
  "published" | "retried" | "failed" | "rate_limited" | "needs_reauth"
> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      if (input.kind === "published") {
        await tx`
          UPDATE awcms_mini_social_publish_jobs
          SET status = 'published', external_post_id = ${input.externalPostId},
              external_post_url = ${input.externalPostUrl}, last_error_code = NULL,
              last_error_message = NULL, next_attempt_at = NULL,
              attempt_count = attempt_count + 1, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${job.id} AND status = 'publishing'
        `;

        await tx`
          INSERT INTO awcms_mini_social_publish_attempts
            (tenant_id, job_id, attempt_number, outcome, external_post_id,
             external_post_url, correlation_id, started_at, finished_at)
          VALUES (
            ${tenantId}, ${job.id}, ${Number(job.attempt_count) + 1}, 'success',
            ${input.externalPostId}, ${input.externalPostUrl}, ${correlationId ?? null},
            ${now}, ${now}
          )
        `;

        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: MODULE_KEY,
          action: "social_publishing.job.published",
          resourceType: "social_publish_job",
          resourceId: job.id,
          severity: "info",
          message: `Social publish job succeeded: ${job.title}.`,
          attributes: { providerKey: job.provider_key },
          correlationId
        });

        return "published";
      }

      if (input.kind === "needs_reauth") {
        await tx`
          UPDATE awcms_mini_social_publish_jobs
          SET status = 'needs_reauth', last_error_code = ${input.errorCode},
              last_error_message = ${input.errorMessage}, next_attempt_at = NULL,
              attempt_count = attempt_count + 1, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${job.id} AND status = 'publishing'
        `;

        await tx`
          INSERT INTO awcms_mini_social_publish_attempts
            (tenant_id, job_id, attempt_number, outcome, error_code, error_message,
             correlation_id, started_at, finished_at)
          VALUES (
            ${tenantId}, ${job.id}, ${Number(job.attempt_count) + 1}, 'needs_reauth',
            ${input.errorCode}, ${input.errorMessage}, ${correlationId ?? null}, ${now}, ${now}
          )
        `;

        await markSocialAccountNeedsReauth(
          tx,
          tenantId,
          job.social_account_id,
          correlationId
        );

        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: MODULE_KEY,
          action: "social_publishing.job.needs_reauth",
          resourceType: "social_publish_job",
          resourceId: job.id,
          severity: "warning",
          message: `Social publish job requires reauthorization: ${job.title}.`,
          attributes: {
            providerKey: job.provider_key,
            errorCode: input.errorCode
          },
          correlationId
        });

        return "needs_reauth";
      }

      // failed / rate_limited — shared retry/backoff + terminal-state logic.
      const newAttemptCount = Number(job.attempt_count) + 1;
      const maxAttempts = Number(job.max_attempts);
      const evaluation =
        input.kind === "rate_limited"
          ? evaluateSocialPublishRateLimitRetry(
              newAttemptCount,
              maxAttempts,
              now,
              input.retryAfterSeconds
            )
          : input.retryable
            ? evaluateSocialPublishRetry(newAttemptCount, maxAttempts, now)
            : { eligible: false as const };

      // `attemptOutcome` is the ATTEMPT ROW's outcome column (what actually
      // happened this attempt) — distinct from this function's RETURN value
      // (which reports to the dispatch-result counters whether the job is
      // still retryable or has now reached a terminal state).
      const attemptOutcome: "failed" | "rate_limited" =
        input.kind === "rate_limited" ? "rate_limited" : "failed";

      if (evaluation.eligible) {
        const revertStatus = job.requires_approval ? "approved" : "pending";
        const dispatchOutcome: "rate_limited" | "retried" =
          input.kind === "rate_limited" ? "rate_limited" : "retried";

        await tx`
          UPDATE awcms_mini_social_publish_jobs
          SET status = ${input.kind === "rate_limited" ? "rate_limited" : revertStatus},
              next_attempt_at = ${evaluation.nextAttemptAt},
              attempt_count = ${newAttemptCount},
              last_error_code = ${input.errorCode}, last_error_message = ${input.errorMessage},
              updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${job.id} AND status = 'publishing'
        `;

        await tx`
          INSERT INTO awcms_mini_social_publish_attempts
            (tenant_id, job_id, attempt_number, outcome, error_code, error_message,
             correlation_id, started_at, finished_at)
          VALUES (
            ${tenantId}, ${job.id}, ${newAttemptCount}, ${attemptOutcome},
            ${input.errorCode}, ${input.errorMessage}, ${correlationId ?? null}, ${now}, ${now}
          )
        `;

        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: MODULE_KEY,
          action:
            attemptOutcome === "rate_limited"
              ? "social_publishing.job.rate_limited"
              : "social_publishing.job.publish_failed",
          resourceType: "social_publish_job",
          resourceId: job.id,
          severity: "warning",
          message: `Social publish job ${attemptOutcome === "rate_limited" ? "rate limited" : "failed"}, retry scheduled: ${job.title}.`,
          attributes: {
            providerKey: job.provider_key,
            errorCode: input.errorCode,
            attemptCount: newAttemptCount
          },
          correlationId
        });

        return dispatchOutcome;
      }

      await tx`
        UPDATE awcms_mini_social_publish_jobs
        SET status = 'failed', next_attempt_at = NULL, attempt_count = ${newAttemptCount},
            last_error_code = ${input.errorCode}, last_error_message = ${input.errorMessage},
            updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${job.id} AND status = 'publishing'
      `;

      await tx`
        INSERT INTO awcms_mini_social_publish_attempts
          (tenant_id, job_id, attempt_number, outcome, error_code, error_message,
           correlation_id, started_at, finished_at)
        VALUES (
          ${tenantId}, ${job.id}, ${newAttemptCount}, ${attemptOutcome},
          ${input.errorCode}, ${input.errorMessage}, ${correlationId ?? null}, ${now}, ${now}
        )
      `;

      await recordAuditEvent(tx, {
        tenantId,
        moduleKey: MODULE_KEY,
        action: "social_publishing.job.publish_failed_terminal",
        resourceType: "social_publish_job",
        resourceId: job.id,
        severity: "critical",
        message: `Social publish job permanently failed after ${newAttemptCount} attempt(s): ${job.title}.`,
        attributes: {
          providerKey: job.provider_key,
          errorCode: input.errorCode
        },
        correlationId
      });

      return "failed";
    },
    { workClass: "background_sync" }
  );
}

function toFinalizeInput(result: SocialProviderPublishResult): FinalizeInput {
  if (result.outcome === "published") {
    return {
      kind: "published",
      externalPostId: result.externalPostId,
      externalPostUrl: result.externalPostUrl
    };
  }

  if (result.outcome === "needs_reauth") {
    return {
      kind: "needs_reauth",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage
    };
  }

  if (result.outcome === "rate_limited") {
    return {
      kind: "rate_limited",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      retryAfterSeconds: result.retryAfterSeconds
    };
  }

  return {
    kind: "failed",
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    retryable: result.retryable
  };
}

/** Dispatches one batch (default `SOCIAL_PUBLISH_DISPATCH_DEFAULT_LIMIT` rows) of due jobs for a single tenant. Safe to call repeatedly/concurrently (claim-lease pattern, same as `dispatchObjectSyncQueue`). */
export async function dispatchSocialPublishQueue(
  sql: Bun.SQL,
  tenantId: string,
  options: DispatchSocialPublishQueueOptions = {}
): Promise<DispatchSocialPublishQueueResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SOCIAL_PUBLISH_DISPATCH_DEFAULT_LIMIT;
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const resolveAdapter = options.resolveAdapter ?? getSocialProviderAdapter;

  const claimed = await claimEligibleJobs(sql, tenantId, now, limit);

  const result: DispatchSocialPublishQueueResult = {
    claimed: claimed.length,
    published: 0,
    retried: 0,
    failed: 0,
    rateLimited: 0,
    needsReauth: 0
  };

  if (claimed.length === 0) {
    return result;
  }

  log("info", "social_publishing.dispatch.claimed", {
    correlationId,
    tenantId,
    moduleKey: MODULE_KEY,
    count: claimed.length
  });

  for (const job of claimed) {
    const jobCorrelationId = job.correlation_id ?? correlationId;
    const adapter = resolveAdapter(job.provider_key);

    let finalizeInput: FinalizeInput;

    if (!adapter) {
      finalizeInput = {
        kind: "failed",
        errorCode: "provider_not_registered",
        errorMessage: `No provider adapter is registered for "${job.provider_key}".`,
        retryable: false
      };
    } else {
      const breaker = getProviderCircuitBreaker(
        `social-publishing:${job.provider_key}`
      );

      if (!breaker.canAttempt(now)) {
        finalizeInput = {
          kind: "failed",
          errorCode: "circuit_breaker_open",
          errorMessage: `Circuit breaker open for provider "${job.provider_key}".`,
          retryable: true
        };
      } else {
        // RLS-protected table — must read inside a tenant-scoped
        // transaction (SET LOCAL app.current_tenant_id), never with the
        // raw `sql` client directly (that would silently return zero rows
        // under FORCE ROW LEVEL SECURITY, not an error, misclassifying
        // every job as "missing_token_reference" -> needs_reauth).
        const accountCredentials = await withTenant(
          sql,
          tenantId,
          (tx) =>
            fetchSocialAccountTokenReferenceForDispatch(
              tx,
              tenantId,
              job.social_account_id
            ),
          { workClass: "background_sync" }
        );

        if (!accountCredentials?.tokenReference) {
          finalizeInput = {
            kind: "needs_reauth",
            errorCode: "missing_token_reference",
            errorMessage: "Connected account has no token reference on file."
          };
        } else {
          try {
            const publishResult = await withTimeout(
              adapter.publish({
                tenantId,
                providerAccountId: accountCredentials.providerAccountId,
                tokenReference: accountCredentials.tokenReference,
                idempotencyKey: job.id,
                content: {
                  title: job.title,
                  excerptOrCaption: job.excerpt_or_caption ?? job.title,
                  canonicalUrl: job.canonical_url,
                  imageUrl: job.image_url
                },
                correlationId: jobCorrelationId
              }),
              SOCIAL_PUBLISH_CALL_TIMEOUT_MS,
              `social-publishing:${job.provider_key}`
            );

            breaker.recordSuccess(now);
            finalizeInput = toFinalizeInput(publishResult);
          } catch (error) {
            breaker.recordFailure(now);
            // NOTE for future provider adapters (#644/#645/#646, noted by
            // both reviewer and security-auditor on PR #731 as a
            // forward-looking, non-blocking concern for THIS foundation
            // issue): `error.message` here is stored verbatim into
            // `last_error_message`/an attempt row, both readable via the
            // admin API. A well-behaved adapter's own `publish()` should
            // never let a thrown error carry a raw token/secret/full
            // provider response body — pre-sanitize before throwing (or
            // return a `SocialProviderPublishFailure` instead of throwing
            // at all, which this dispatcher never re-serializes raw). This
            // catch-all is a safety net for genuinely unexpected
            // exceptions (network/bug), not a substitute for an adapter
            // sanitizing its own expected error paths.
            finalizeInput = {
              kind: "failed",
              errorCode: "provider_call_exception",
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "Unknown provider error.",
              retryable: true
            };
          }
        }
      }
    }

    const outcome = await finalizeJob(
      sql,
      tenantId,
      job,
      finalizeInput,
      now,
      jobCorrelationId
    );

    if (outcome === "published") result.published += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "rate_limited") result.rateLimited += 1;
    else if (outcome === "needs_reauth") result.needsReauth += 1;
    else result.retried += 1;
  }

  return result;
}
