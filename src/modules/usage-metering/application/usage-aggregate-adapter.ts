/**
 * `usage_aggregate` capability adapter (Issue #875, epic #868, ADR-0022 §2).
 * `usage_metering` PROVIDES this read-only port; `subscription_billing` (#876)
 * and the admin quota view wire it at their composition root, bound to the
 * caller's tenant-scoped `tx`. It CONSUMES `effective_entitlement` (#871) for
 * the quota LIMIT — injected at the composition root, never a direct import.
 *
 * The quota decision is AUTHORITATIVE, not a cache: it recomputes the current
 * reset window LIVE from the immutable events (so a lagging aggregation worker
 * can never let a hard quota over-admit), and FAILS CLOSED when that recompute
 * cannot run (`usage_unavailable` -> a hard quota denies). Entitlement !=
 * permission — a positive decision never authorizes; the consumer still passes
 * its own RBAC/ABAC/RLS gates.
 */
import { log } from "../../../lib/logging/logger";
import type { EffectiveEntitlementPort } from "../../_shared/ports/effective-entitlement-port";
import type {
  UsageAggregatePort,
  UsageQuotaDecisionView,
  UsageWindowTotal
} from "../../_shared/ports/usage-aggregate-port";
import { decideQuota } from "../domain/quota-decision";
import {
  computeWindowAggregate,
  windowBoundsFor,
  windowStartFor,
  windowTypeForResetPeriod,
  type WindowType
} from "../domain/meter-semantics";
import {
  resolveMeter,
  resolveQuotaPolicyForMeter,
  type SaasContractRegistry
} from "./meter-registry";
import { freshnessOf } from "./usage-read-query";
import { readWindowSources } from "./usage-source-query";

type StoredAggregateRow = {
  window_end: Date;
  aggregate_value: number | string;
  event_count: number | string;
  correction_count: number | string;
  distinct_count: number | string | null;
  last_event_time: Date | null;
  content_hash: string;
  window_closed: boolean;
  computed_at: Date;
};

export function createUsageAggregatePort(
  tx: Bun.SQL,
  tenantId: string,
  registry: SaasContractRegistry,
  entitlementPort: EffectiveEntitlementPort,
  nowProvider: () => Date = () => new Date()
): UsageAggregatePort {
  return {
    async getWindowTotal(
      meterKey: string,
      windowType: WindowType,
      at?: Date
    ): Promise<UsageWindowTotal | null> {
      const now = nowProvider();
      const windowStart = windowStartFor(windowType, at ?? now);
      const rows = (await tx`
        SELECT window_end, aggregate_value, event_count, correction_count, distinct_count,
          last_event_time, content_hash, window_closed, computed_at
        FROM awcms_mini_usage_aggregates
        WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
          AND window_type = ${windowType} AND window_start = ${windowStart}
      `) as StoredAggregateRow[];
      if (!rows[0]) {
        return null;
      }
      const row = rows[0];
      return {
        meterKey,
        windowType,
        windowStart: windowStart.toISOString(),
        windowEnd: row.window_end.toISOString(),
        value: Number(row.aggregate_value),
        eventCount: Number(row.event_count),
        correctionCount: Number(row.correction_count),
        distinctCount:
          row.distinct_count === null ? null : Number(row.distinct_count),
        lastEventTime: row.last_event_time?.toISOString() ?? null,
        freshness: freshnessOf(row.computed_at, now),
        computedAt: row.computed_at.toISOString(),
        contentHash: row.content_hash,
        windowClosed: row.window_closed
      };
    },

    async getQuotaDecision(
      meterKey: string,
      at?: Date
    ): Promise<UsageQuotaDecisionView> {
      const now = nowProvider();
      const meter = resolveMeter(registry, meterKey);
      const { resetPeriod, enforcement } = resolveQuotaPolicyForMeter(
        registry,
        meterKey
      );
      const allowance = await entitlementPort.getQuota(meterKey);

      // Unknown meter -> not entitled (fail-closed, no such quota).
      if (!meter) {
        return {
          meterKey,
          allowed: false,
          isUnlimited: false,
          limit: 0,
          used: 0,
          remaining: 0,
          unit: allowance.unit,
          enforcement,
          status: "not_entitled",
          freshness: "current"
        };
      }

      // AUTHORITATIVE current-window usage: recompute live from immutable events
      // (never trust the possibly-stale materialized aggregate for enforcement).
      const windowType = windowTypeForResetPeriod(resetPeriod);
      const { start, end } = windowBoundsFor(windowType, at ?? now);
      let used = 0;
      let freshness: UsageWindowTotal["freshness"] = "current";
      try {
        const sources = await readWindowSources(
          tx,
          tenantId,
          meterKey,
          start,
          end,
          null
        );
        used = computeWindowAggregate(
          meter.aggregation,
          meter.valueType,
          sources.events,
          sources.corrections
        ).value;
      } catch (error) {
        // Fail-closed: usage could not be determined -> a hard quota denies.
        freshness = "unavailable";
        log("error", "usage_metering.quota_recompute_failed", {
          moduleKey: "usage_metering",
          tenantId,
          errorName: error instanceof Error ? error.name : "unknown"
        });
      }

      return decideQuota({
        meterKey,
        enforcement,
        allowance: {
          allowed: allowance.allowed,
          isUnlimited: allowance.isUnlimited,
          limit: allowance.limit,
          unit: allowance.unit
        },
        used,
        freshness
      });
    }
  };
}
