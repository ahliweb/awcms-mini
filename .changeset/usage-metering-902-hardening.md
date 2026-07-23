---
"awcms-mini": patch
---

Security/hardening (usage_metering, Issue #902 follow-ups from PR #899 review):

- **PII pseudonymization of unique-count distinct keys (L2).** A `unique_count`
  meter's `unique_dimension` is now charset-restricted in the pure domain
  (`^[A-Za-z0-9._:@-]{1,200}$` — an id/uuid/email-shaped token; whitespace /
  control bytes / structural payload rejected fail-closed), and — for a meter
  whose #874 `privacyClassification` is `pseudonymous` or `personal` — replaced
  at the write path with a cardinality-preserving HMAC-SHA256 pseudonym before it
  is persisted, so a raw email/handle a producer used as the distinct key is no
  longer stored verbatim in `awcms_mini_usage_events.unique_dimension` (nor leaked
  through the read DTO). The HMAC reuses `AUTH_JWT_SECRET` (the audit-`ipHash`
  key) with input domain-separation and is read per call / fail-closed. Distinct
  counts are unchanged (same input → same digest). No API contract change — the
  field stays a string.
- **Reconciliation discovery no longer silently capped (L3).** Source-row
  discovery keyset-pages both the events and corrections streams instead of a
  single `LIMIT 50_000`, so a window whose only evidence lies beyond that limit is
  still flagged `missing`/`drift` (completeness gap closed). A high configurable
  hard bound now marks the run `discoveryIncomplete` (a durable report sentinel +
  a new `discoveryIncomplete` run field + a logged warning + a warning-severity
  audit) rather than truncating silently.
- **Tests.** Added a route-level `Idempotency-Key` replay test for the corrections
  endpoint (L4b) and a two-worker `FOR UPDATE SKIP LOCKED` lease-contention test
  for the aggregation worker (L4c), plus domain/unit coverage for the charset gate
  and the pseudonym, and integration coverage for the pseudonymization and the
  paged/flagged discovery.

No schema migration (the existing `unique_dimension` length CHECK is the DB
backstop; the pseudonym is necessarily an application-layer control). OpenAPI:
`UsageReconciliationRun` gains a `discoveryIncomplete` boolean and the drift-entry
`kind` gains `discovery_incomplete`.
