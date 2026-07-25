/**
 * Fleet-wide operational signals this module contributes (Issue #930, epic
 * #868). Per-tenant half only — the cross-tenant iteration lives in the
 * composition-root job (ADR-0022 §6b).
 */

/**
 * The dunning stage label an overdue invoice is reported under. Drawn from
 * the bounded `requested_lifecycle_state` enum the dunning-attempt table
 * already constrains, plus `none` for an invoice that is overdue but which
 * dunning has not touched yet.
 *
 * `none` is the operationally interesting one: a pile-up there means overdue
 * invoices are not ENTERING dunning at all, which is a different fault from a
 * pile-up in a later stage (that one means they are not LEAVING it).
 */
const NO_DUNNING_STAGE = "none";

export type SubscriptionBillingSignals = {
  /** Overdue issued invoices, grouped by the stage of their most recent dunning attempt. */
  overdueByDunningStage: Record<string, number>;
  /** Total overdue, for the subsystem-level manual-intervention gauge. */
  overdueTotal: number;
};

export async function collectSubscriptionBillingSignals(
  tx: Bun.SQL,
  now: Date
): Promise<SubscriptionBillingSignals> {
  // Only `issued` invoices can be overdue: `draft` was never presented,
  // `paid` is settled, `void` was withdrawn. Grouping by the LATEST attempt
  // (not by every attempt) keeps one invoice counted exactly once — a
  // straight join to the attempts table would multiply an invoice by its
  // retry count and silently inflate the metric as dunning worked harder.
  const rows = (await tx`
    SELECT COALESCE(latest.requested_lifecycle_state, ${NO_DUNNING_STAGE}) AS stage,
           count(*)::int AS row_count
    FROM awcms_mini_subscription_billing_invoices AS invoice
    LEFT JOIN LATERAL (
      SELECT attempt.requested_lifecycle_state
      FROM awcms_mini_subscription_billing_dunning_attempts AS attempt
      WHERE attempt.tenant_id = invoice.tenant_id
        AND attempt.invoice_id = invoice.id
      ORDER BY attempt.attempt_no DESC
      LIMIT 1
    ) AS latest ON true
    WHERE invoice.status = 'issued'
      AND invoice.due_at IS NOT NULL
      AND invoice.due_at < ${now}
    GROUP BY 1
  `) as { stage: string; row_count: number }[];

  const overdueByDunningStage: Record<string, number> = {};
  let overdueTotal = 0;

  for (const row of rows) {
    overdueByDunningStage[row.stage] =
      (overdueByDunningStage[row.stage] ?? 0) + row.row_count;
    overdueTotal += row.row_count;
  }

  return { overdueByDunningStage, overdueTotal };
}
