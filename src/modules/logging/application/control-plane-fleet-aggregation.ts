/**
 * Fleet aggregation for the control-plane signals (Issue #930, epic #868).
 *
 * ## Why this file takes DATA and imports no other module
 *
 * The sweep necessarily touches five modules' tables, but nothing here
 * imports them. Each owning module exposes its own per-tenant collector
 * (`<module>/application/control-plane-signals.ts`) reading only its OWN
 * tables inside that tenant's RLS context; the composition-root job
 * (`scripts/control-plane-fleet-sweep.ts`) is the single place allowed to
 * import several of them at once, and it hands the results here as plain
 * data. So this file — the part with the interesting logic — stays a pure
 * function that a unit test can drive without a database, and no module
 * boundary is crossed to get it.
 *
 * ## Why the totals are fleet-wide and unlabeled by tenant
 *
 * ADR-0022 §6b and #930's own acceptance criterion: control-plane metrics
 * must never carry per-tenant, per-resource, or per-provider-reference
 * labels. Aggregating to a fleet total here is not a convenience — it is the
 * mechanism that makes the cardinality bound true. An operator who needs to
 * know WHICH tenant is stuck uses the authorized, re-authorized read APIs;
 * the metric's job is only to say that someone is.
 */
import { recordGauge } from "../../../lib/observability/metrics-port";

/** One tenant's readings, as returned by the owning modules' collectors. */
export type TenantControlPlaneReadings = {
  provisioningBacklogByAttemptStatus: Record<string, number>;
  provisioningOldestPendingSeconds: number | null;
  provisioningManualInterventionCount: number;
  entitlementExpiredUnswept: number;
  billingOverdueByDunningStage: Record<string, number>;
  billingOverdueTotal: number;
  paymentDeadLetterDepth: number;
  paymentWebhookBacklog: number;
  paymentManualInterventionCount: number;
  projectionsStale: number;
  projectionsFailed: number;
};

export type FleetControlPlaneTotals = {
  tenantsScanned: number;
  provisioningBacklogByAttemptStatus: Record<string, number>;
  /** Fleet-wide maximum, not a sum: the question an age objective answers is "has ANYTHING been waiting too long", and summing ages across tenants would be meaningless. */
  provisioningOldestPendingSeconds: number;
  entitlementExpiredUnswept: number;
  billingOverdueByDunningStage: Record<string, number>;
  paymentDeadLetterDepth: number;
  paymentWebhookBacklog: number;
  projectionsStale: number;
  projectionsFailed: number;
  manualInterventionBySubsystem: Record<string, number>;
};

function addInto(
  target: Record<string, number>,
  source: Record<string, number>
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

export function aggregateFleetTotals(
  readings: readonly TenantControlPlaneReadings[]
): FleetControlPlaneTotals {
  const totals: FleetControlPlaneTotals = {
    tenantsScanned: readings.length,
    provisioningBacklogByAttemptStatus: {},
    provisioningOldestPendingSeconds: 0,
    entitlementExpiredUnswept: 0,
    billingOverdueByDunningStage: {},
    paymentDeadLetterDepth: 0,
    paymentWebhookBacklog: 0,
    projectionsStale: 0,
    projectionsFailed: 0,
    manualInterventionBySubsystem: {}
  };

  for (const reading of readings) {
    addInto(
      totals.provisioningBacklogByAttemptStatus,
      reading.provisioningBacklogByAttemptStatus
    );
    addInto(
      totals.billingOverdueByDunningStage,
      reading.billingOverdueByDunningStage
    );

    totals.provisioningOldestPendingSeconds = Math.max(
      totals.provisioningOldestPendingSeconds,
      reading.provisioningOldestPendingSeconds ?? 0
    );
    totals.entitlementExpiredUnswept += reading.entitlementExpiredUnswept;
    totals.paymentDeadLetterDepth += reading.paymentDeadLetterDepth;
    totals.paymentWebhookBacklog += reading.paymentWebhookBacklog;
    totals.projectionsStale += reading.projectionsStale;
    totals.projectionsFailed += reading.projectionsFailed;

    addInto(totals.manualInterventionBySubsystem, {
      provisioning: reading.provisioningManualInterventionCount,
      payment: reading.paymentManualInterventionCount,
      // An expired-but-unrevoked entitlement and an overdue invoice both
      // sit waiting on a decision nobody has made, which is what this
      // subsystem gauge is for.
      entitlement: reading.entitlementExpiredUnswept,
      billing: reading.billingOverdueTotal
    });
  }

  return totals;
}

/**
 * Pushes the aggregated totals through the metrics port.
 *
 * Every gauge is emitted even when its value is ZERO. That is deliberate: a
 * gauge that simply stops being reported is indistinguishable, in every
 * time-series backend, from a collector that died — and "no data" usually
 * renders as a gap rather than an alarm. Explicitly writing 0 is what lets
 * an operator tell "nothing is wrong" from "nothing is watching".
 */
export function emitFleetControlPlaneMetrics(
  totals: FleetControlPlaneTotals
): void {
  for (const attemptStatus of ["pending", "running", "waiting", "failed"]) {
    recordGauge(
      "control_plane_provisioning_backlog",
      totals.provisioningBacklogByAttemptStatus[attemptStatus] ?? 0,
      { attemptStatus }
    );
  }

  recordGauge(
    "control_plane_provisioning_oldest_pending_seconds",
    totals.provisioningOldestPendingSeconds
  );
  recordGauge(
    "control_plane_entitlement_expired_unswept",
    totals.entitlementExpiredUnswept
  );

  for (const [dunningStage, count] of Object.entries(
    totals.billingOverdueByDunningStage
  )) {
    recordGauge("control_plane_invoice_overdue_total", count, { dunningStage });
  }

  recordGauge("control_plane_payment_dlq_depth", totals.paymentDeadLetterDepth);
  recordGauge("control_plane_webhook_backlog", totals.paymentWebhookBacklog);
  recordGauge("control_plane_projection_stale_total", totals.projectionsStale, {
    freshnessState: "stale"
  });
  recordGauge(
    "control_plane_projection_stale_total",
    totals.projectionsFailed,
    { freshnessState: "failed" }
  );

  for (const subsystem of [
    "provisioning",
    "entitlement",
    "billing",
    "payment"
  ]) {
    recordGauge(
      "control_plane_manual_intervention_total",
      totals.manualInterventionBySubsystem[subsystem] ?? 0,
      { subsystem }
    );
  }
}
