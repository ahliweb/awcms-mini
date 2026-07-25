/**
 * Unit tests for the fleet aggregation half of the control-plane sweep
 * (Issue #930, epic #868).
 *
 * The aggregation is where the two properties that actually matter live:
 * every gauge is emitted even at zero (so "nothing wrong" is distinguishable
 * from "nothing watching"), and the oldest-pending AGE is a fleet maximum
 * rather than a sum. Both are easy to regress into something that still looks
 * plausible, so both are asserted directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createInMemoryMetricsPort,
  type InMemoryMetricsPort
} from "../../src/lib/observability/in-memory-metrics-port";
import {
  resetMetricsPortForTests,
  setMetricsPort
} from "../../src/lib/observability/metrics-port";
import {
  aggregateFleetTotals,
  emitFleetControlPlaneMetrics,
  type TenantControlPlaneReadings
} from "../../src/modules/logging/application/control-plane-fleet-aggregation";

function reading(
  overrides: Partial<TenantControlPlaneReadings> = {}
): TenantControlPlaneReadings {
  return {
    provisioningBacklogByAttemptStatus: {},
    provisioningOldestPendingSeconds: null,
    provisioningManualInterventionCount: 0,
    entitlementExpiredUnswept: 0,
    billingOverdueByDunningStage: {},
    billingOverdueTotal: 0,
    paymentDeadLetterDepth: 0,
    paymentWebhookBacklog: 0,
    paymentManualInterventionCount: 0,
    projectionsStale: 0,
    projectionsFailed: 0,
    ...overrides
  };
}

describe("control-plane fleet aggregation (Issue #930)", () => {
  describe("aggregateFleetTotals", () => {
    test("sums counts across tenants and keeps label breakdowns", () => {
      const totals = aggregateFleetTotals([
        reading({
          provisioningBacklogByAttemptStatus: { pending: 2, waiting: 1 },
          paymentDeadLetterDepth: 3
        }),
        reading({
          provisioningBacklogByAttemptStatus: { pending: 5, failed: 4 },
          paymentDeadLetterDepth: 1
        })
      ]);

      expect(totals.tenantsScanned).toBe(2);
      expect(totals.provisioningBacklogByAttemptStatus).toEqual({
        pending: 7,
        waiting: 1,
        failed: 4
      });
      expect(totals.paymentDeadLetterDepth).toBe(4);
    });

    test("oldest-pending age is the fleet MAXIMUM, never a sum", () => {
      // Summing ages would produce a number that grows with tenant count and
      // means nothing — the question is "has anything been waiting too long",
      // and one tenant waiting 3h is not the same as three waiting 1h each.
      const totals = aggregateFleetTotals([
        reading({ provisioningOldestPendingSeconds: 3600 }),
        reading({ provisioningOldestPendingSeconds: 7200 }),
        reading({ provisioningOldestPendingSeconds: 1800 })
      ]);

      expect(totals.provisioningOldestPendingSeconds).toBe(7200);
    });

    test("a tenant with no backlog contributes no age", () => {
      const totals = aggregateFleetTotals([
        reading({ provisioningOldestPendingSeconds: null }),
        reading({ provisioningOldestPendingSeconds: 900 })
      ]);
      expect(totals.provisioningOldestPendingSeconds).toBe(900);
    });

    test("an empty fleet aggregates to zeros, not NaN or undefined", () => {
      const totals = aggregateFleetTotals([]);
      expect(totals.tenantsScanned).toBe(0);
      expect(totals.provisioningOldestPendingSeconds).toBe(0);
      expect(totals.entitlementExpiredUnswept).toBe(0);
      expect(totals.provisioningBacklogByAttemptStatus).toEqual({});
    });

    test("manual-intervention totals are split by subsystem", () => {
      const totals = aggregateFleetTotals([
        reading({
          provisioningManualInterventionCount: 2,
          paymentManualInterventionCount: 3,
          entitlementExpiredUnswept: 1,
          billingOverdueTotal: 7
        })
      ]);

      expect(totals.manualInterventionBySubsystem).toEqual({
        provisioning: 2,
        payment: 3,
        entitlement: 1,
        billing: 7
      });
    });
  });

  describe("emitFleetControlPlaneMetrics", () => {
    let port: InMemoryMetricsPort;

    beforeEach(() => {
      port = createInMemoryMetricsPort();
      setMetricsPort(port);
    });

    afterEach(() => {
      resetMetricsPortForTests();
    });

    test("emits every gauge even when the value is zero", () => {
      // A gauge that stops being reported is indistinguishable from a dead
      // collector in every time-series backend, and "no data" usually renders
      // as a gap rather than an alarm. Writing 0 explicitly is what lets an
      // operator tell "nothing is wrong" from "nothing is watching".
      emitFleetControlPlaneMetrics(aggregateFleetTotals([]));

      const gauges = port.getSnapshot().gauges;
      for (const attemptStatus of ["pending", "running", "waiting", "failed"]) {
        expect(
          gauges[
            `control_plane_provisioning_backlog{attemptStatus=${attemptStatus}}`
          ]
        ).toBe(0);
      }
      for (const subsystem of [
        "provisioning",
        "entitlement",
        "billing",
        "payment"
      ]) {
        expect(
          gauges[
            `control_plane_manual_intervention_total{subsystem=${subsystem}}`
          ]
        ).toBe(0);
      }
      expect(gauges["control_plane_payment_dlq_depth{}"]).toBe(0);
      expect(gauges["control_plane_webhook_backlog{}"]).toBe(0);
      expect(
        gauges["control_plane_provisioning_oldest_pending_seconds{}"]
      ).toBe(0);
      expect(gauges["control_plane_entitlement_expired_unswept{}"]).toBe(0);
      expect(
        gauges["control_plane_projection_stale_total{freshnessState=stale}"]
      ).toBe(0);
      expect(
        gauges["control_plane_projection_stale_total{freshnessState=failed}"]
      ).toBe(0);
    });

    test("emits the aggregated values", () => {
      emitFleetControlPlaneMetrics(
        aggregateFleetTotals([
          reading({
            provisioningBacklogByAttemptStatus: { waiting: 6 },
            provisioningOldestPendingSeconds: 4242,
            paymentWebhookBacklog: 11,
            projectionsFailed: 2,
            billingOverdueByDunningStage: { past_due: 4, none: 9 }
          })
        ])
      );

      const gauges = port.getSnapshot().gauges;
      expect(
        gauges["control_plane_provisioning_backlog{attemptStatus=waiting}"]
      ).toBe(6);
      expect(
        gauges["control_plane_provisioning_oldest_pending_seconds{}"]
      ).toBe(4242);
      expect(gauges["control_plane_webhook_backlog{}"]).toBe(11);
      expect(
        gauges["control_plane_projection_stale_total{freshnessState=failed}"]
      ).toBe(2);
      expect(
        gauges["control_plane_invoice_overdue_total{dunningStage=past_due}"]
      ).toBe(4);
      expect(
        gauges["control_plane_invoice_overdue_total{dunningStage=none}"]
      ).toBe(9);
    });

    test("no emitted series carries a tenant-identifying label", () => {
      // The structural guarantee #930 requires: the metrics port drops any
      // label not in the metric's allowedLabelKeys, so even if the aggregator
      // tried to pass one it could never reach an adapter.
      emitFleetControlPlaneMetrics(
        aggregateFleetTotals([
          reading({ provisioningBacklogByAttemptStatus: { pending: 1 } })
        ])
      );

      for (const series of Object.keys(port.getSnapshot().gauges)) {
        expect(`${series}:${/tenant/i.test(series)}`).toBe(`${series}:false`);
      }
    });
  });
});
