/**
 * Fleet-wide operational signals this module contributes (Issue #930, epic
 * #868). Per-tenant half only — the cross-tenant iteration lives in the
 * composition-root job (ADR-0022 §6b).
 */

export type PaymentGatewaySignals = {
  /**
   * Outbox rows that exhausted their retries. Deliberately NOT framed as a
   * backlog: nothing here will ever be attempted again without operator
   * action, so a non-zero value is permanent loss until someone acts, not
   * work that drains on its own.
   */
  deadLetterDepth: number;
  /**
   * Signature-verified webhook envelopes received but not yet normalized.
   * Events that keep arriving and are never absorbed are invisible in
   * payment-intent state alone — the same blind spot this module's reporting
   * projection exists to cover.
   */
  webhookBacklog: number;
  /** Outbox rows awaiting a human decision are not modelled separately; `dead` rows ARE the manual-intervention queue for this subsystem. */
  manualInterventionCount: number;
};

export async function collectPaymentGatewaySignals(
  tx: Bun.SQL
): Promise<PaymentGatewaySignals> {
  const outboxRows = (await tx`
    SELECT count(*)::int AS row_count
    FROM awcms_mini_payment_gateway_outbox
    WHERE status = 'dead'
  `) as { row_count: number }[];

  const inboxRows = (await tx`
    SELECT count(*)::int AS row_count
    FROM awcms_mini_payment_gateway_webhook_inbox
    WHERE status = 'received'
  `) as { row_count: number }[];

  const deadLetterDepth = outboxRows[0]?.row_count ?? 0;

  return {
    deadLetterDepth,
    webhookBacklog: inboxRows[0]?.row_count ?? 0,
    manualInterventionCount: deadLetterDepth
  };
}
