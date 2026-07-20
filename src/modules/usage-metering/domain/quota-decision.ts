/**
 * Usage quota decision (Issue #875, epic #868, ADR-0022). PURE — no I/O.
 * Combines a tenant's entitlement quota ALLOWANCE (the limit, read from #871's
 * fail-closed `effective_entitlement` port) with the tenant's CURRENT usage in
 * the reset window to produce a quota decision — and FAILS SAFELY when usage is
 * unavailable, per the meter/quota's enforcement policy (issue #875 AC "quota
 * decisions integrate with #871 and fail safely when usage is stale/unavailable
 * according to descriptor policy").
 *
 * NOT solely a cache: the application adapter feeds `used` from an AUTHORITATIVE
 * live recompute of the current window over the immutable events (not the
 * materialized aggregate), so a lagging aggregation worker can never let a hard
 * quota over-admit. `freshness: "unavailable"` is reserved for the case the
 * recompute itself could not run — where a HARD quota fails CLOSED (deny).
 *
 * ENTITLEMENT != PERMISSION (ADR-0022 §4): a positive quota decision is a
 * COMMERCIAL fact, never an authorization — the consumer still passes its own
 * RBAC/ABAC/RLS gates.
 */
export type UsageFreshness = "current" | "delayed" | "stale" | "unavailable";

export type QuotaEnforcement = "hard" | "soft" | "advisory";

/** The allowance side, as read from `effective_entitlement`'s `getQuota`. */
export type QuotaAllowanceInput = {
  allowed: boolean;
  isUnlimited: boolean;
  limit: number | null;
  unit: string | null;
};

export type QuotaDecisionStatus =
  "within" | "exceeded" | "not_entitled" | "usage_unavailable";

export type UsageQuotaDecision = {
  meterKey: string;
  /** Fail-closed: `true` ONLY when the tenant is entitled AND (unlimited OR within limit) — or a soft/advisory quota that never blocks. */
  allowed: boolean;
  isUnlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  unit: string | null;
  enforcement: QuotaEnforcement;
  status: QuotaDecisionStatus;
  freshness: UsageFreshness;
};

export type QuotaDecisionInput = {
  meterKey: string;
  enforcement: QuotaEnforcement;
  allowance: QuotaAllowanceInput;
  used: number;
  freshness: UsageFreshness;
};

export function decideQuota(input: QuotaDecisionInput): UsageQuotaDecision {
  const { meterKey, enforcement, allowance, used, freshness } = input;
  const base = {
    meterKey,
    isUnlimited: allowance.isUnlimited,
    limit: allowance.limit,
    used,
    unit: allowance.unit,
    enforcement,
    freshness
  };

  // Not entitled to this quota at all -> deny (fail-closed, ADR-0022 §4).
  if (!allowance.allowed) {
    return {
      ...base,
      allowed: false,
      isUnlimited: false,
      limit: 0,
      remaining: 0,
      unit: allowance.unit,
      status: "not_entitled"
    };
  }

  // Usage could not be determined authoritatively -> a HARD quota fails closed
  // (deny); soft/advisory never block but flag the condition.
  if (freshness === "unavailable") {
    return {
      ...base,
      allowed: enforcement !== "hard",
      remaining: null,
      status: "usage_unavailable"
    };
  }

  // Unlimited allowance -> always within.
  if (allowance.isUnlimited) {
    return { ...base, allowed: true, remaining: null, status: "within" };
  }

  const limit = allowance.limit ?? 0;
  const exceeded = used >= limit;
  if (exceeded) {
    return {
      ...base,
      // hard blocks at the limit; soft/advisory allow overage but record it.
      allowed: enforcement !== "hard",
      remaining: 0,
      status: "exceeded"
    };
  }
  return {
    ...base,
    allowed: true,
    remaining: Math.max(0, limit - used),
    status: "within"
  };
}
