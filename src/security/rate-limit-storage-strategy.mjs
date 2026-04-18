/**
 * Mini stores short-lived rate-limit and lockout counters in a shared TTL-capable
 * relational store so counters survive restarts and multi-instance deployment.
 *
 * Rationale:
 * - the current deployment target needs counters to survive process restarts and
 *   remain shared across instances
 * - the repo already uses PostgreSQL plus explicit migrations as the main
 *   durable coordination layer
 * - lockout flows still keep high-churn state separate from audit facts, while
 *   remaining operationally simple for the current single-tenant deployment
 */

export const RATE_LIMIT_STORAGE_STRATEGY = Object.freeze({
  kind: "shared-sql-store",
  durable_table_required: true,
  scope_dimensions: ["ip", "account", "route"],
  required_capabilities: ["increment", "read", "reset", "ttl"],
  fallback_behavior: "fail-closed-on-security-sensitive-routes",
  notes: [
    "Use a shared TTL-capable counter backend that survives app restarts for the supported deployment path.",
    "The current implementation stores counters in PostgreSQL via a dedicated rate_limit_counters table.",
    "Security incidents and lockout decisions still belong in audit_logs and security_events once those flows are implemented.",
  ],
});

export function getRateLimitStorageStrategy() {
  return RATE_LIMIT_STORAGE_STRATEGY;
}
