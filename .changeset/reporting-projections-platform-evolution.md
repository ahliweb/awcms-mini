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
