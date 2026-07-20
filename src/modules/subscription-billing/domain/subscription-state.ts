/**
 * `subscription_billing` subscription state machine (Issue #876, epic #868,
 * ADR-0022 §11). Mirrors the DB trigger whitelist in `sql/091` EXACTLY (a
 * change here must change both). A subscription moves forward only along the
 * legal edges; a lost/invalid transition is a deterministic 409 at the write
 * path (optimistic `version` guard).
 *
 *   pending  -> trialing | active | canceled
 *   trialing -> active | past_due | canceled | expired
 *   active   -> past_due | canceled | expired
 *   past_due -> active | canceled | expired
 *   canceled -> (terminal)
 *   expired  -> (terminal)
 */
export type SubscriptionState =
  "pending" | "trialing" | "active" | "past_due" | "canceled" | "expired";

export type SubscriptionSource =
  "operator" | "system" | "scheduler" | "provisioning" | "lifecycle";

export const SUBSCRIPTION_STATES: readonly SubscriptionState[] = [
  "pending",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired"
];

export const SUBSCRIPTION_SOURCES: readonly SubscriptionSource[] = [
  "operator",
  "system",
  "scheduler",
  "provisioning",
  "lifecycle"
];

const LEGAL: Readonly<Record<SubscriptionState, readonly SubscriptionState[]>> =
  {
    pending: ["trialing", "active", "canceled"],
    trialing: ["active", "past_due", "canceled", "expired"],
    active: ["past_due", "canceled", "expired"],
    past_due: ["active", "canceled", "expired"],
    canceled: [],
    expired: []
  };

export function isSubscriptionState(
  value: unknown
): value is SubscriptionState {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATES as readonly string[]).includes(value)
  );
}

export function isSubscriptionSource(
  value: unknown
): value is SubscriptionSource {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_SOURCES as readonly string[]).includes(value)
  );
}

export function isLegalSubscriptionTransition(
  from: SubscriptionState,
  to: SubscriptionState
): boolean {
  return LEGAL[from].includes(to);
}

export function isTerminalSubscriptionState(state: SubscriptionState): boolean {
  return LEGAL[state].length === 0;
}

/** A subscription can accrue billing periods only while it is live. */
export function isBillableSubscriptionState(state: SubscriptionState): boolean {
  return state === "trialing" || state === "active" || state === "past_due";
}
