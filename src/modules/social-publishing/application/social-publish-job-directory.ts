import { recordAuditEvent } from "../../logging/application/audit-log";

export type SocialPublishJobView = {
  id: string;
  tenantId: string;
  socialAccountId: string;
  ruleId: string | null;
  articleId: string;
  providerKey: string;
  triggerEvent: string;
  action: string;
  status: string;
  requiresApproval: boolean;
  title: string;
  excerptOrCaption: string | null;
  canonicalUrl: string;
  imageUrl: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  externalPostId: string | null;
  externalPostUrl: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SocialPublishJobRow = {
  id: string;
  tenant_id: string;
  social_account_id: string;
  rule_id: string | null;
  article_id: string;
  provider_key: string;
  trigger_event: string;
  action: string;
  status: string;
  requires_approval: boolean;
  title: string;
  excerpt_or_caption: string | null;
  canonical_url: string;
  image_url: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  external_post_id: string | null;
  external_post_url: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: SocialPublishJobRow): SocialPublishJobView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    socialAccountId: row.social_account_id,
    ruleId: row.rule_id,
    articleId: row.article_id,
    providerKey: row.provider_key,
    triggerEvent: row.trigger_event,
    action: row.action,
    status: row.status,
    requiresApproval: row.requires_approval,
    title: row.title,
    excerptOrCaption: row.excerpt_or_caption,
    canonicalUrl: row.canonical_url,
    imageUrl: row.image_url,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    externalPostId: row.external_post_id,
    externalPostUrl: row.external_post_url,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const AUDIT_MODULE_KEY = "social_publishing";
const AUDIT_RESOURCE_TYPE = "social_publish_job";

export async function fetchSocialPublishJobById(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<SocialPublishJobView | null> {
  const rows = (await tx`
    SELECT id, tenant_id, social_account_id, rule_id, article_id, provider_key,
      trigger_event, action, status, requires_approval, title, excerpt_or_caption,
      canonical_url, image_url, approved_by, approved_at, attempt_count, max_attempts,
      next_attempt_at, external_post_id, external_post_url, last_error_code,
      last_error_message, cancelled_at, cancel_reason, correlation_id, created_at, updated_at
    FROM awcms_mini_social_publish_jobs
    WHERE tenant_id = ${tenantId} AND id = ${id}
  `) as SocialPublishJobRow[];

  const row = rows[0];
  return row ? toView(row) : null;
}

export type ListSocialPublishJobsOptions = {
  status?: string;
  limit?: number;
};

export async function listSocialPublishJobs(
  tx: Bun.SQL,
  tenantId: string,
  options: ListSocialPublishJobsOptions = {}
): Promise<SocialPublishJobView[]> {
  const limit = Math.min(options.limit ?? 100, 200);

  const rows = options.status
    ? ((await tx`
        SELECT id, tenant_id, social_account_id, rule_id, article_id, provider_key,
          trigger_event, action, status, requires_approval, title, excerpt_or_caption,
          canonical_url, image_url, approved_by, approved_at, attempt_count, max_attempts,
          next_attempt_at, external_post_id, external_post_url, last_error_code,
          last_error_message, cancelled_at, cancel_reason, correlation_id, created_at, updated_at
        FROM awcms_mini_social_publish_jobs
        WHERE tenant_id = ${tenantId} AND status = ${options.status}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as SocialPublishJobRow[])
    : ((await tx`
        SELECT id, tenant_id, social_account_id, rule_id, article_id, provider_key,
          trigger_event, action, status, requires_approval, title, excerpt_or_caption,
          canonical_url, image_url, approved_by, approved_at, attempt_count, max_attempts,
          next_attempt_at, external_post_id, external_post_url, last_error_code,
          last_error_message, cancelled_at, cancel_reason, correlation_id, created_at, updated_at
        FROM awcms_mini_social_publish_jobs
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as SocialPublishJobRow[]);

  return rows.map(toView);
}

export type SocialPublishAttemptView = {
  id: string;
  jobId: string;
  attemptNumber: number;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  externalPostId: string | null;
  externalPostUrl: string | null;
  correlationId: string | null;
  startedAt: Date;
  finishedAt: Date;
  createdAt: Date;
};

type SocialPublishAttemptRow = {
  id: string;
  job_id: string;
  attempt_number: number;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  external_post_id: string | null;
  external_post_url: string | null;
  correlation_id: string | null;
  started_at: Date;
  finished_at: Date;
  created_at: Date;
};

function toAttemptView(row: SocialPublishAttemptRow): SocialPublishAttemptView {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    externalPostId: row.external_post_id,
    externalPostUrl: row.external_post_url,
    correlationId: row.correlation_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at
  };
}

export async function listSocialPublishAttemptsForJob(
  tx: Bun.SQL,
  tenantId: string,
  jobId: string
): Promise<SocialPublishAttemptView[]> {
  const rows = (await tx`
    SELECT id, job_id, attempt_number, outcome, error_code, error_message,
      external_post_id, external_post_url, correlation_id, started_at, finished_at, created_at
    FROM awcms_mini_social_publish_attempts
    WHERE tenant_id = ${tenantId} AND job_id = ${jobId}
    ORDER BY attempt_number ASC
  `) as SocialPublishAttemptRow[];

  return rows.map(toAttemptView);
}

/** `POST .../jobs/{id}/approve` — only from `requires_approval`. */
export async function approveSocialPublishJob(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  note: string | null,
  correlationId?: string
): Promise<SocialPublishJobView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_jobs
    SET status = 'approved', approved_by = ${actorTenantUserId}, approved_at = now(),
        approval_note = ${note}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'requires_approval'
    RETURNING id, tenant_id, social_account_id, rule_id, article_id, provider_key,
      trigger_event, action, status, requires_approval, title, excerpt_or_caption,
      canonical_url, image_url, approved_by, approved_at, attempt_count, max_attempts,
      next_attempt_at, external_post_id, external_post_url, last_error_code,
      last_error_message, cancelled_at, cancel_reason, correlation_id, created_at, updated_at
  `) as SocialPublishJobRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.job.approved",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `Social publish job approved: ${updated.title}.`,
    correlationId
  });

  return updated;
}

const CANCELLABLE_STATUSES = [
  "pending",
  "requires_approval",
  "approved",
  "scheduled",
  "failed",
  "rate_limited",
  "needs_reauth"
];

/** `POST .../jobs/{id}/cancel` — from any non-terminal-success/non-already-cancelled status. */
export async function cancelSocialPublishJob(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  reason: string,
  correlationId?: string
): Promise<SocialPublishJobView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_jobs
    SET status = 'cancelled', cancelled_by = ${actorTenantUserId}, cancelled_at = now(),
        cancel_reason = ${reason}, next_attempt_at = NULL, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = ANY(${tx.array(CANCELLABLE_STATUSES, "text")})
    RETURNING id, tenant_id, social_account_id, rule_id, article_id, provider_key,
      trigger_event, action, status, requires_approval, title, excerpt_or_caption,
      canonical_url, image_url, approved_by, approved_at, attempt_count, max_attempts,
      next_attempt_at, external_post_id, external_post_url, last_error_code,
      last_error_message, cancelled_at, cancel_reason, correlation_id, created_at, updated_at
  `) as SocialPublishJobRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.job.cancelled",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "warning",
    message: `Social publish job cancelled: ${updated.title}.`,
    attributes: { reason },
    correlationId
  });

  return updated;
}

const RETRYABLE_STATUSES = ["failed", "rate_limited", "needs_reauth"];

/**
 * `POST .../jobs/{id}/retry` — moves a terminal-ish job back into the
 * dispatch pipeline immediately (`next_attempt_at = NULL` so the
 * dispatcher's next pass claims it right away, bypassing any remaining
 * backoff wait). Reverts to `approved` (not `pending`) when the job
 * originally required approval — a manual retry does not require
 * re-approval, the operator retrying IS already an authorized action.
 * `attempt_count` is deliberately NOT reset — the backoff/terminal-failure
 * budget keeps counting across manual retries too, so a job cannot be
 * retried forever by an operator repeatedly clicking retry.
 */
export async function retrySocialPublishJob(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  correlationId?: string
): Promise<SocialPublishJobView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_social_publish_jobs
    SET status = CASE WHEN requires_approval THEN 'approved' ELSE 'pending' END,
        next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
      AND status = ANY(${tx.array(RETRYABLE_STATUSES, "text")}) AND attempt_count < max_attempts
    RETURNING id, tenant_id, social_account_id, rule_id, article_id, provider_key,
      trigger_event, action, status, requires_approval, title, excerpt_or_caption,
      canonical_url, image_url, approved_by, approved_at, attempt_count, max_attempts,
      next_attempt_at, external_post_id, external_post_url, last_error_code,
      last_error_message, cancelled_at, cancel_reason, correlation_id, created_at, updated_at
  `) as SocialPublishJobRow[];

  const row = rows[0];
  if (!row) return null;

  const updated = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "social_publishing.job.retry_requested",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    severity: "info",
    message: `Social publish job retry requested: ${updated.title}.`,
    correlationId
  });

  return updated;
}
