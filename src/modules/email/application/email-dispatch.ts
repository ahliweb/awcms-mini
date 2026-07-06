/**
 * Internal email dispatcher (Issue #495). NOT a public HTTP endpoint — same
 * "trusted internal worker only" boundary as
 * `sync-storage/application/object-dispatch.ts`. Invoked by
 * `scripts/email-dispatch.ts`, one tenant at a time.
 *
 * Three-phase pattern (ADR-0006 — never call a provider inside a DB
 * transaction), directly mirroring `object-dispatch.ts`:
 *
 * 1. CLAIM — one short transaction flips eligible `queued`/`retry_wait`
 *    rows to a transient `sending` status (`FOR UPDATE SKIP LOCKED`),
 *    reusing `next_attempt_at` as the claim lease expiry (no new column —
 *    same reuse `sql/020`'s own comment documents).
 * 2. SEND — for each claimed row, renders the body from its
 *    `template_key`/`variables` (`../domain/email-template-render.ts`,
 *    Issue #495's minimal renderer — Issue #498 will own the full "safe
 *    rendering" version behind the same seam) and calls the resolved
 *    `EmailProvider` (`../infrastructure/email-provider-resolver.ts`)
 *    *outside* any transaction.
 * 3. FINALIZE — one short transaction per row flips `sending` to `sent`,
 *    or (on failure) to `retry_wait` with backoff
 *    (`../domain/email-retry.ts`) or `failed` once retries are exhausted
 *    or the failure is marked non-retryable. Every attempt — success or
 *    failure — is recorded in `awcms_mini_email_delivery_attempts`.
 *
 * If `EMAIL_ENABLED` is not `"true"`, `dispatchEmailQueue` returns
 * immediately without claiming anything — a disabled/misconfigured
 * provider never causes claimed rows to pile up in `sending` limbo (doc 18
 * feature-flag rule: provider off never touches the provider at all).
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenant } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { resolveEmailSendMaxRetries } from "../domain/email-config";
import { redactEmailAddressesInText } from "../domain/email-log-redaction";
import { evaluateEmailRetry } from "../domain/email-retry";
import {
  renderEmailTemplate,
  type EmailTemplateSource
} from "../domain/email-template-render";
import type { EmailProvider } from "../domain/email-provider-contract";
import { resolveEmailProvider } from "../infrastructure/email-provider-resolver";

const MODULE_KEY = "email";
const CIRCUIT_BREAKER_KEY = "email-mailketing";

export const EMAIL_DISPATCH_DEFAULT_LIMIT = 25;
export const EMAIL_DISPATCH_LEASE_MINUTES = 2;
const MAX_RESPONSE_SNIPPET_LENGTH = 500;

type ClaimedRow = {
  id: string;
  correlation_id: string | null;
  category: string;
  template_key: string | null;
  to_address: string;
  subject: string;
  variables: Record<string, unknown> | null;
  retry_count: string | number;
};

export type DispatchEmailQueueOptions = {
  limit?: number;
  now?: Date;
  correlationId?: string;
  resolveProvider?: (env?: NodeJS.ProcessEnv) => EmailProvider;
  fromAddress?: string;
  fromName?: string;
  env?: NodeJS.ProcessEnv;
};

export type DispatchEmailQueueResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  breakerOpen: boolean;
};

function toStringVariables(
  variables: Record<string, unknown> | null
): Record<string, string> {
  if (!variables) {
    return {};
  }

  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(variables)) {
    output[key] = typeof value === "string" ? value : String(value);
  }

  return output;
}

async function claimEligibleEntries(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<ClaimedRow[]> {
  const leaseExpiry = new Date(
    now.getTime() + EMAIL_DISPATCH_LEASE_MINUTES * 60_000
  );

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = await tx`
        UPDATE awcms_mini_email_messages
        SET status = 'sending', next_attempt_at = ${leaseExpiry}
        WHERE id IN (
          SELECT id FROM awcms_mini_email_messages
          WHERE tenant_id = ${tenantId}
            AND status IN ('queued', 'retry_wait')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY
            CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
            created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, correlation_id, category, template_key, to_address, subject, variables, retry_count
      `;

      return rows as unknown as ClaimedRow[];
    },
    { workClass: "background_sync" }
  );
}

async function fetchActiveTemplate(
  sql: Bun.SQL,
  tenantId: string,
  templateKey: string
): Promise<EmailTemplateSource | null> {
  const rows = await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      SELECT subject_template, text_body_template, html_body_template
      FROM awcms_mini_email_templates
      WHERE tenant_id = ${tenantId} AND template_key = ${templateKey}
        AND is_active = true AND deleted_at IS NULL
    `,
    { workClass: "background_sync" }
  );

  const row = (
    rows as {
      subject_template: string;
      text_body_template: string | null;
      html_body_template: string | null;
    }[]
  )[0];

  if (!row) {
    return null;
  }

  return {
    subjectTemplate: row.subject_template,
    textBodyTemplate: row.text_body_template,
    htmlBodyTemplate: row.html_body_template
  };
}

async function recordDeliveryAttempt(
  sql: Bun.SQL,
  tenantId: string,
  messageId: string,
  attemptNo: number,
  outcome: "success" | "failure",
  providerName: string,
  providerResponseSnippet: string | null,
  errorMessage: string | null
): Promise<void> {
  await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_mini_email_delivery_attempts
        (tenant_id, message_id, attempt_no, outcome, provider_name, provider_response_snippet, error_message)
      VALUES (
        ${tenantId}, ${messageId}, ${attemptNo}, ${outcome}, ${providerName},
        ${providerResponseSnippet}, ${errorMessage}
      )
    `,
    { workClass: "background_sync" }
  );
}

async function finalizeSent(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  providerName: string,
  providerMessageId: string | undefined
): Promise<void> {
  await withTenant(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_mini_email_messages
      SET status = 'sent', sent_at = now(), next_attempt_at = null,
          provider_name = ${providerName}, provider_message_id = ${providerMessageId ?? null}
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );
}

async function finalizeFailure(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  currentRetryCount: number,
  maxRetries: number,
  retryable: boolean,
  now: Date,
  errorMessage: string
): Promise<{ eligible: boolean }> {
  const evaluation = retryable
    ? evaluateEmailRetry(currentRetryCount, maxRetries, now)
    : { eligible: false as const };

  if (evaluation.eligible) {
    await withTenant(
      sql,
      tenantId,
      (tx) => tx`
        UPDATE awcms_mini_email_messages
        SET status = 'retry_wait', retry_count = ${currentRetryCount + 1},
            next_attempt_at = ${evaluation.nextAttemptAt}, last_error = ${errorMessage}
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
      UPDATE awcms_mini_email_messages
      SET status = 'failed', retry_count = ${currentRetryCount + 1},
          next_attempt_at = null, last_error = ${errorMessage}
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );

  return { eligible: false };
}

/**
 * Dispatches one batch (default `EMAIL_DISPATCH_DEFAULT_LIMIT` rows) of due
 * `awcms_mini_email_messages` entries for a single tenant. Safe to call
 * repeatedly (claim-lease pattern); the CLI script loops per tenant to
 * drain a larger backlog.
 */
export async function dispatchEmailQueue(
  sql: Bun.SQL,
  tenantId: string,
  options: DispatchEmailQueueOptions = {}
): Promise<DispatchEmailQueueResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const limit = options.limit ?? EMAIL_DISPATCH_DEFAULT_LIMIT;
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const maxRetries = resolveEmailSendMaxRetries(env);
  const breaker = getProviderCircuitBreaker(CIRCUIT_BREAKER_KEY);
  const breakerOpen = !breaker.canAttempt(now);

  const result: DispatchEmailQueueResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    breakerOpen
  };

  if (env.EMAIL_ENABLED !== "true") {
    return result;
  }

  if (breakerOpen) {
    return result;
  }

  const claimed = await claimEligibleEntries(sql, tenantId, now, limit);
  result.claimed = claimed.length;

  if (claimed.length === 0) {
    return result;
  }

  log("info", "email.dispatch.claimed", {
    correlationId,
    tenantId,
    moduleKey: MODULE_KEY,
    count: claimed.length
  });

  const provider = (options.resolveProvider ?? resolveEmailProvider)(env);
  const fromAddress = options.fromAddress ?? env.EMAIL_FROM_ADDRESS ?? "";
  const fromName = options.fromName ?? env.EMAIL_FROM_NAME ?? "";

  for (const entry of claimed) {
    const retryCount = Number(entry.retry_count);
    const attemptNo = retryCount + 1;
    const messageCorrelationId = entry.correlation_id ?? correlationId;

    let template: EmailTemplateSource | null = null;

    if (entry.template_key) {
      template = await fetchActiveTemplate(sql, tenantId, entry.template_key);
    }

    if (!template) {
      const errorMessage = entry.template_key
        ? `Template not found or inactive: ${entry.template_key}`
        : "Message has no template_key.";

      await recordDeliveryAttempt(
        sql,
        tenantId,
        entry.id,
        attemptNo,
        "failure",
        env.EMAIL_PROVIDER ?? "unknown",
        null,
        errorMessage
      );
      await finalizeFailure(
        sql,
        tenantId,
        entry.id,
        retryCount,
        maxRetries,
        false,
        now,
        errorMessage
      );
      result.failed += 1;
      continue;
    }

    const rendered = renderEmailTemplate(
      template,
      toStringVariables(entry.variables)
    );

    const deliveryResult = await provider.send({
      to: [{ address: entry.to_address }],
      from: { address: fromAddress, name: fromName },
      subject: entry.subject || rendered.subject,
      textBody: rendered.textBody,
      htmlBody: rendered.htmlBody,
      correlationId: messageCorrelationId
    });

    if (deliveryResult.ok) {
      await recordDeliveryAttempt(
        sql,
        tenantId,
        entry.id,
        attemptNo,
        "success",
        env.EMAIL_PROVIDER ?? "unknown",
        deliveryResult.providerMessageId
          ? redactEmailAddressesInText(
              deliveryResult.providerMessageId.slice(
                0,
                MAX_RESPONSE_SNIPPET_LENGTH
              )
            )
          : null,
        null
      );
      await finalizeSent(
        sql,
        tenantId,
        entry.id,
        env.EMAIL_PROVIDER ?? "unknown",
        deliveryResult.providerMessageId
      );
      result.sent += 1;
      continue;
    }

    const safeError = redactEmailAddressesInText(
      deliveryResult.error.slice(0, MAX_RESPONSE_SNIPPET_LENGTH)
    );

    await recordDeliveryAttempt(
      sql,
      tenantId,
      entry.id,
      attemptNo,
      "failure",
      env.EMAIL_PROVIDER ?? "unknown",
      safeError,
      safeError
    );

    const finalized = await finalizeFailure(
      sql,
      tenantId,
      entry.id,
      retryCount,
      maxRetries,
      deliveryResult.retryable,
      now,
      safeError
    );

    if (finalized.eligible) {
      result.retried += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}
