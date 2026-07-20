/**
 * `usage_aggregate` capability port (Issue #875, epic #868 SaaS control plane,
 * ADR-0022 §2). The READ-ONLY seam through which a downstream module — chiefly
 * `subscription_billing` (#876) — reads a tenant's effective usage windows and
 * quota decisions. Consumers import only this TYPE from neutral `_shared/`
 * ground; the concrete adapter
 * (`usage-metering/application/usage-aggregate-adapter.ts`) is wired at the
 * composition root, bound to the caller's already tenant-scoped `tx`
 * (mirroring `effective_entitlement`'s read-port adapter).
 *
 * TENANT-FACING SHAPE ONLY: the window total + quota decision carry the
 * deterministic numeric aggregate and freshness — never operator-only data.
 * `contentHash` fingerprints ONLY the exposed projection (epic pattern #5, no
 * oracle). The quota decision is FAIL-CLOSED (issue #875 AC): a hard quota
 * denies when usage is unavailable, and never relies solely on a stale cache
 * (the adapter recomputes the current window authoritatively from immutable
 * events).
 */
export type UsageFreshness = "current" | "delayed" | "stale" | "unavailable";

export type UsageWindowTotal = {
  meterKey: string;
  windowType: "hour" | "day" | "month";
  windowStart: string;
  windowEnd: string;
  value: number;
  eventCount: number;
  correctionCount: number;
  distinctCount: number | null;
  lastEventTime: string | null;
  freshness: UsageFreshness;
  computedAt: string | null;
  contentHash: string | null;
  windowClosed: boolean;
};

export type UsageQuotaDecisionView = {
  meterKey: string;
  allowed: boolean;
  isUnlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  unit: string | null;
  enforcement: "hard" | "soft" | "advisory";
  status: "within" | "exceeded" | "not_entitled" | "usage_unavailable";
  freshness: UsageFreshness;
};

export type UsageAggregatePort = {
  /** The materialized window total for the `windowType` window containing `at` (defaults to now), or `null` if none has been computed yet. */
  getWindowTotal(
    meterKey: string,
    windowType: "hour" | "day" | "month",
    at?: Date
  ): Promise<UsageWindowTotal | null>;
  /** The fail-closed quota decision for `meterKey` in its reset window at `at` (defaults to now) — authoritative (recomputes the current window live). */
  getQuotaDecision(
    meterKey: string,
    at?: Date
  ): Promise<UsageQuotaDecisionView>;
};
