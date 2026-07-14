/**
 * Bounded declarative outbound-subscription filter (Issue #754 scope:
 * "filters using a bounded declarative schema"). Deliberately NOT a
 * tenant-authored expression language/script (doc 21 §7 guardrail: no
 * runtime code eval from tenant input) — a flat map of dotted payload
 * path -> exact scalar match, with hard bounds on key count and path
 * depth/length. A subscription with an EMPTY filter (`{}`) matches every
 * event of its `subscribed_event_type` (the common case).
 */
export type SubscriptionFilter = Record<string, string | number | boolean>;

export const MAX_FILTER_KEYS = 10;
export const MAX_FILTER_PATH_DEPTH = 4;
export const MAX_FILTER_PATH_SEGMENT_LENGTH = 64;

export type FilterValidationResult =
  { ok: true } | { ok: false; reason: string };

export function validateSubscriptionFilter(
  filter: unknown
): FilterValidationResult {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    return { ok: false, reason: "filter_must_be_flat_object" };
  }

  const entries = Object.entries(filter as Record<string, unknown>);

  if (entries.length > MAX_FILTER_KEYS) {
    return { ok: false, reason: "too_many_filter_keys" };
  }

  for (const [key, value] of entries) {
    const segments = key.split(".");

    if (segments.length === 0 || segments.length > MAX_FILTER_PATH_DEPTH) {
      return { ok: false, reason: "filter_path_too_deep" };
    }

    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment.length > MAX_FILTER_PATH_SEGMENT_LENGTH
      )
    ) {
      return { ok: false, reason: "filter_path_segment_invalid" };
    }

    if (!(
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )) {
      return { ok: false, reason: "filter_value_must_be_scalar" };
    }
  }

  return { ok: true };
}

function getPath(payload: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((accumulator, segment) => {
    if (
      accumulator &&
      typeof accumulator === "object" &&
      !Array.isArray(accumulator)
    ) {
      return (accumulator as Record<string, unknown>)[segment];
    }
    return undefined;
  }, payload);
}

/** Assumes `filter` already passed `validateSubscriptionFilter` — never called with unvalidated input from a write path. */
export function matchesSubscriptionFilter(
  payload: Record<string, unknown>,
  filter: SubscriptionFilter
): boolean {
  return Object.entries(filter).every(
    ([path, expected]) => getPath(payload, path) === expected
  );
}
