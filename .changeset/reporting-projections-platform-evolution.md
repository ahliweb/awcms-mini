---
"awcms-mini": minor
---

Extend the `reporting` module with module-contributed read-model
projections (Issue #753, epic `platform-evolution` #738 Wave 3): a
`ProjectionDescriptor` contract modules contribute entries to (three
registered here — `access_audit_summary`, `module_activity_summary`,
`event_activity_summary`), a bounded incremental `cursor_table` engine,
a crash-safe idempotent rebuild engine, live-computed freshness/
staleness status, on-demand source reconciliation, scheduled CSV/JSON
exports with checksum/expiry/secure download, eleven new
`/api/v1/reports/{projections,exports}*` endpoints (ABAC-gated,
audited, `Idempotency-Key`-protected), two new scheduled jobs with
least-privilege worker grants, and a new admin screen at
`/admin/reporting/projections`. Seven new tenant-scoped RLS-protected
tables (`sql/066`-`067`), fully additive to the five existing live
`/api/v1/reports/*` views.

Each `ProjectionDescriptor`'s own `requiredPermission` is now enforced
a second time at read time (list/get/reconcile), independent of the
coarse module-level ABAC gate, so a caller granted `reports:read` but
not a specific projection's own permission is filtered out of the
list and gets `403` on a direct lookup. The event-driven incremental
updater for `event_activity_summary` no longer silently loses an
event's count when a concurrent rebuild is cancelled mid-flight (it
now throws to roll back its own idempotency marker instead of writing
one before the effect is confirmed) while a watermark comparison
against the rebuild's own cursor prevents the same event being
double-counted once the rebuild completes normally. Scheduled exports
now reject a non-empty `filter` (`400 NOT_IMPLEMENTED`) instead of
silently ignoring it, and export downloads reverify the SHA-256
checksum against the bytes actually read from disk before serving
them.
