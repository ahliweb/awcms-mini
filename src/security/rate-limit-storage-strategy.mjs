/**
 * Mini delegates short-lived rate-limit and lockout counters to runtime storage
 * instead of persisting them in the main relational database.
 *
 * Rationale:
 * - counters are high-churn and windowed, which is a poor fit for the current
 *   repo's migration-first relational model
 * - the application already expects environment-specific runtime concerns such
 *   as proxies, headers, and process configuration outside core business data
 * - later lockout flows can depend on this contract without prematurely
 *   coupling to a specific database table or vendor cache implementation
 */

export const RATE_LIMIT_STORAGE_STRATEGY = Object.freeze({
  kind: "runtime-middleware",
  durable_table_required: false,
  scope_dimensions: ["ip", "account", "route"],
  required_capabilities: ["increment", "read", "reset", "ttl"],
  fallback_behavior: "fail-closed-on-security-sensitive-routes",
  notes: [
    "Use ephemeral runtime storage such as edge middleware state, Redis, or an equivalent TTL-capable counter backend.",
    "Do not persist lockout counters in the primary governance database unless this contract is explicitly revised.",
    "Security incidents and lockout decisions still belong in audit_logs and security_events once those flows are implemented.",
  ],
});

export function getRateLimitStorageStrategy() {
  return RATE_LIMIT_STORAGE_STRATEGY;
}
