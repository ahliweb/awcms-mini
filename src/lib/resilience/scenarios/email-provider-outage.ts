/**
 * "provider-outage-email" scenario (Issue #699). Reuses the REAL email
 * outbox dispatcher (`src/modules/email/application/email-dispatch.ts`,
 * Issue #495) end to end against a real PostgreSQL — no mocked
 * dispatcher, only a fake `EmailProvider` (the same seam
 * `tests/integration/email-dispatch.integration.test.ts` already uses via
 * `resolveProvider`) standing in for a genuinely down/timing-out
 * Mailketing endpoint.
 *
 * This is the concrete, end-to-end proof of two acceptance criteria at
 * once:
 * - ADR-0006 ("critical local transactions remain independent of
 *   optional provider outages"): the message row is inserted in its own
 *   ordinary transaction, independent of whether the provider is up.
 *   `dispatchEmailQueue`'s CLAIM phase (its own short transaction) then
 *   runs regardless of the provider's health — only the SEND phase
 *   (outside any transaction, per ADR-0006) can fail from the outage.
 * - "Retry/idempotency behavior avoids duplicate side effects": the
 *   first (failing) attempt must leave the message in a retryable wait
 *   state with exactly one recorded delivery attempt; forcing the retry
 *   due and re-dispatching once the provider "recovers" must send exactly
 *   once more (never a duplicate), for exactly two delivery attempts
 *   total (one failure, one success).
 *
 * R2/object-storage sync uses the identical outbox+circuit-breaker shape
 * (`src/modules/sync-storage/application/object-dispatch.ts`) already
 * covered by its own integration suite
 * (`tests/integration/object-dispatch.integration.test.ts`) — this
 * scenario is not duplicated for R2 (see `docs/awcms-mini/
 * resilience-dr-verification.md` §Scenario catalog for the explicit
 * implemented-vs-cross-verified disclosure).
 *
 * Phases:
 * - Setup: fresh disposable tenant + email template + one queued
 *   message, isolated by a random UUID tenant id.
 * - Execute: dispatch once with a provider that fails the first call
 *   (`retryable: true`, simulating a provider timeout/outage), then force
 *   the retry due and dispatch again with the SAME provider instance
 *   (which now succeeds on its second call, simulating recovery).
 * - Verify: message status transitions queued -> retry_wait -> sent;
 *   exactly 2 provider calls; exactly 2 recorded delivery attempts (no
 *   duplicate send).
 * - Cleanup: delete every fixture row this scenario created (its own
 *   randomly-generated tenant id only — never touches any other tenant's
 *   data), close its own connection.
 */
import {
  hashIdentifier,
  maskIdentifier,
  normalizeIdentifier
} from "../../../modules/profile-identity/domain/identifier";
import { dispatchEmailQueue } from "../../../modules/email/application/email-dispatch";
import type {
  EmailDeliveryResult,
  EmailMessage,
  EmailProvider
} from "../../../modules/email/domain/email-provider-contract";
import { resetProviderCircuitBreakersForTests } from "../../database/circuit-breaker";
import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

const BASE_ENV = {
  EMAIL_ENABLED: "true",
  EMAIL_FROM_ADDRESS: "no-reply@dr-drill.local",
  EMAIL_FROM_NAME: "AWCMS-Mini DR Drill"
} as NodeJS.ProcessEnv;

/** Fails the first `send()` (retryable — a provider timeout/outage), succeeds every call after (recovery). */
function createOutageThenRecoveredProvider(): {
  provider: EmailProvider;
  callCount: () => number;
} {
  let calls = 0;

  return {
    callCount: () => calls,
    provider: {
      async send(_message: EmailMessage): Promise<EmailDeliveryResult> {
        calls += 1;

        if (calls === 1) {
          return {
            ok: false,
            error: "dr-drill: simulated provider outage (connect timeout)",
            retryable: true
          };
        }

        return { ok: true, providerMessageId: `dr-drill-fake:${calls}` };
      },
      async healthCheck() {
        return { ok: false, error: "dr-drill: simulated outage" };
      }
    }
  };
}

export function emailProviderOutageScenario(): ScenarioDefinition {
  return {
    name: "provider-outage-email",
    tier: "safe",
    timeoutMs: 15_000,
    async run(ctx): Promise<ScenarioOutcome> {
      const sql = new Bun.SQL(ctx.databaseUrl, { max: 4 });
      const tenantId = crypto.randomUUID();
      const templateKey = "dr_drill.provider_outage";

      try {
        // Setup.
        resetProviderCircuitBreakersForTests();

        await sql`
          INSERT INTO awcms_mini_tenants
            (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
          VALUES (
            ${tenantId}, ${"dr-drill-" + tenantId.slice(0, 8)}, 'DR Drill Tenant',
            'DR Drill Tenant Legal', 'active', 'en', 'light'
          )
        `;
        await sql`
          INSERT INTO awcms_mini_email_templates
            (tenant_id, template_key, name, subject_template, text_body_template, created_by, updated_by)
          VALUES (
            ${tenantId}, ${templateKey}, 'DR Drill Template',
            ${{ en: "DR drill subject" }}, ${{ en: "Body {{note}}" }},
            gen_random_uuid(), gen_random_uuid()
          )
        `;

        const normalized = normalizeIdentifier(
          "email",
          "dr-drill-recipient@example.com"
        );
        const messageRows = (await sql`
          INSERT INTO awcms_mini_email_messages
            (tenant_id, category, template_key, to_address, to_address_hash, to_address_masked, subject, variables)
          VALUES (
            ${tenantId}, 'dr_drill.provider_outage', ${templateKey},
            ${normalized}, ${hashIdentifier(normalized)}, ${maskIdentifier("email", normalized)},
            'DR drill subject', ${{ note: "outage-test" }}
          )
          RETURNING id
        `) as { id: string }[];
        const messageId = messageRows[0]!.id;

        const { provider, callCount } = createOutageThenRecoveredProvider();

        // Execute (1): provider is "down".
        const firstAttempt = await dispatchEmailQueue(sql, tenantId, {
          env: BASE_ENV,
          resolveProvider: () => provider
        });

        const afterFirst = (await sql`
          SELECT status FROM awcms_mini_email_messages WHERE id = ${messageId}
        `) as { status: string }[];

        // Verify: the local claim transaction committed independent of the
        // provider outage (the row still exists and was correctly moved to
        // a retryable wait state, not lost/stuck).
        if (firstAttempt.claimed !== 1 || firstAttempt.retried !== 1) {
          return {
            ok: false,
            detail: `Expected exactly 1 claimed + 1 retried on the outage attempt, got ${JSON.stringify(firstAttempt)}.`
          };
        }
        if (afterFirst[0]?.status !== "retry_wait") {
          return {
            ok: false,
            detail: `Expected message status "retry_wait" after a retryable provider failure, got "${afterFirst[0]?.status}".`
          };
        }

        // Force the retry due now (this drill proves the mechanism, not
        // the real backoff wall-clock wait) and dispatch again: provider
        // "recovers" on its second call.
        await sql`
          UPDATE awcms_mini_email_messages
          SET next_attempt_at = now() - interval '1 second'
          WHERE id = ${messageId}
        `;

        const secondAttempt = await dispatchEmailQueue(sql, tenantId, {
          env: BASE_ENV,
          resolveProvider: () => provider
        });

        const afterSecond = (await sql`
          SELECT status FROM awcms_mini_email_messages WHERE id = ${messageId}
        `) as { status: string }[];
        const deliveryAttemptCountRows = (await sql`
          SELECT count(*)::int AS count
          FROM awcms_mini_email_delivery_attempts
          WHERE message_id = ${messageId}
        `) as { count: number }[];
        const deliveryAttemptCount = deliveryAttemptCountRows[0]?.count ?? 0;

        if (secondAttempt.claimed !== 1 || secondAttempt.sent !== 1) {
          return {
            ok: false,
            detail: `Expected the recovered provider attempt to send successfully, got ${JSON.stringify(secondAttempt)}.`
          };
        }
        if (afterSecond[0]?.status !== "sent") {
          return {
            ok: false,
            detail: `Expected message status "sent" after recovery, got "${afterSecond[0]?.status}".`
          };
        }
        if (callCount() !== 2) {
          return {
            ok: false,
            detail: `Expected exactly 2 provider calls total (1 failed + 1 recovered), got ${callCount()} — a duplicate send would be a real defect.`
          };
        }
        if (deliveryAttemptCount !== 2) {
          return {
            ok: false,
            detail: `Expected exactly 2 recorded delivery attempts (1 failure + 1 success), got ${deliveryAttemptCount}.`
          };
        }

        return {
          ok: true,
          detail:
            "Local email-outbox transaction committed independently of the " +
            "provider outage (ADR-0006); the retryable failure was retried " +
            "exactly once on recovery with no duplicate send (idempotent).",
          metrics: {
            providerCallsTotal: callCount(),
            deliveryAttemptsRecorded: deliveryAttemptCount
          }
        };
      } finally {
        // Cleanup — only this scenario's own randomly-generated tenant id.
        await sql`DELETE FROM awcms_mini_email_delivery_attempts WHERE tenant_id = ${tenantId}`.catch(
          () => undefined
        );
        await sql`DELETE FROM awcms_mini_email_messages WHERE tenant_id = ${tenantId}`.catch(
          () => undefined
        );
        await sql`DELETE FROM awcms_mini_email_templates WHERE tenant_id = ${tenantId}`.catch(
          () => undefined
        );
        await sql`DELETE FROM awcms_mini_tenants WHERE id = ${tenantId}`.catch(
          () => undefined
        );
        await sql.close({ timeout: 1 });
      }
    }
  };
}
