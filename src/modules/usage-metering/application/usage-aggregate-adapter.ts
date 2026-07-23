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
 * cannot run (`usage_unavailable` -> a hard quota denies). The recompute is
 * BOUNDED (Issue #901): the reset window is decomposed into indexed settled
 * sub-aggregates + a live open tail under a source-row budget (see
 * `quota-usage-recompute.ts`), so it is O(sub-windows) instead of
 * O(events-per-reset-window) while preserving the never-over-admit invariant.
 * Entitlement != permission — a positive decision never authorizes; the
 * consumer still passes its own RBAC/ABAC/RLS gates.
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
import {
  computeBoundedQuotaUsage,
  QuotaSourceBudgetExceededError
} from "./quota-usage-recompute";
import { freshnessOf } from "./usage-read-query";

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
  nowProvider: () => Date = () => new Date(),
  /**
   * Composition-root tuning of the bounded quota recompute (Issue #901). The
   * default `QUOTA_MAX_SOURCE_ROWS` is used in production; tests inject a small
   * budget to exercise the fail-closed path without seeding millions of rows.
   */
  options?: { quotaMaxSourceRows?: number }
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
      // — never trust the possibly-stale materialized aggregate for enforcement.
      // BOUNDED (Issue #901): the reset window is decomposed into indexed settled
      // sub-aggregates + a live open tail (details in quota-usage-recompute.ts),
      // so this is O(sub-windows) instead of O(events-per-reset-window), while
      // still failing closed — a lagging worker or a blown row budget can never
      // let a hard quota over-admit.
      const windowType = windowTypeForResetPeriod(resetPeriod);
      const { start, end } = windowBoundsFor(windowType, at ?? now);
      let used = 0;
      let freshness: UsageWindowTotal["freshness"] = "current";
      try {
        used = await computeBoundedQuotaUsage(
          tx,
          tenantId,
          meterKey,
          meter.aggregation,
          meter.valueType,
          windowType,
          start,
          end,
          now,
          { maxSourceRows: options?.quotaMaxSourceRows }
        );
      } catch (error) {
        // Fail-closed: usage could not be determined (row budget exceeded or a
        // query error) -> a hard quota denies (`usage_unavailable`).
        freshness = "unavailable";
        log("error", "usage_metering.quota_recompute_failed", {
          moduleKey: "usage_metering",
          tenantId,
          errorName: error instanceof Error ? error.name : "unknown",
          overBudget: error instanceof QuotaSourceBudgetExceededError
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
