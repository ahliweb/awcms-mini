# Rate-Limit Storage Strategy

`AWM-071` chooses the non-database path described as optional in the implementation plan.

Decision:
- Mini delegates rate-limit and temporary lockout counters to runtime storage.
- Mini does not create a `rate_limit_counters` SQL table in the current implementation.

Why:
- Counter state is short-lived, high-churn, and window-based.
- The current repo stores durable governance and audit records in SQL, but rate-limit counters are operational middleware state.
- This keeps the primary database focused on durable facts while still allowing strict throttling later.

Required runtime capabilities:
- Atomic increment
- Read current counter state
- Reset by scope key
- TTL/window expiry support

Supported scope dimensions:
- IP address
- Account or user identity
- Route or action key

Expected backends:
- Edge/runtime middleware state
- Redis or equivalent TTL-capable cache
- Another environment-provided counter service with the same semantics

Follow-on implications:
- `AWM-076` should build lockout logic against the exported strategy contract in `src/security/rate-limit-storage-strategy.mjs`.
- Durable security outcomes still go to `security_events` and `audit_logs`; only volatile counters stay outside SQL.
