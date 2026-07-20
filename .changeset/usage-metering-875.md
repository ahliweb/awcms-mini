---
"awcms-mini": minor
---

feat(usage-metering): add idempotent usage events, aggregation, quotas, corrections, and reconciliation (#875)

The third SaaS control-plane module (epic #868 Wave 1, ADR-0022) — a tenant-scoped,
default-disabled provider-neutral metering foundation. Owning modules emit reviewed,
numeric-only meter events in their own commit through a transaction-safe append port;
an async, resumable worker deterministically materializes usage windows from the
immutable events plus signed corrections; a reconciliation pass recomputes windows
from the immutable source and flags drift; and a read-only aggregate port exposes
effective usage plus a fail-closed quota decision that billing (#876) reads.

- **Schema** (`sql/087`, `sql/088`): tenant-scoped `awcms_mini_usage_events`,
  `awcms_mini_usage_corrections`, `awcms_mini_usage_aggregates`,
  `awcms_mini_usage_aggregation_cursors`, `awcms_mini_usage_reconciliation_runs`
  — all `FORCE ROW LEVEL SECURITY`, predicate always and only `tenant_id`.
  Append-only immutability + write-once triggers (events/corrections/runs
  append-only; aggregate window identity frozen + `source_watermark` monotonic +
  `window_closed` one-way; cursor `checkpoint_seq` monotonic) beneath the app
  guards, plus least-privilege REVOKEs (app never writes aggregates; worker never
  writes source; purge is the only, worker-only DELETE, legal-hold-respecting).
  Migration numbering skips 085/086 (reserved for provisioning #872, not yet merged).
- **Ports** (`_shared/ports/usage-append-port.ts`, `usage-aggregate-port.ts`): the
  transaction-safe `usage_append` seam (a producing module records usage in the same
  commit as its business transaction — the events table is the outbox) and the
  read-only `usage_aggregate` seam. Consumes #871's fail-closed `effective_entitlement`
  at the composition root only.
- **Idempotency**: identity binds `(tenant, producer, meter, sourceEventId,
  sourceVersion)` — a duplicate producer event is counted once (`ON CONFLICT DO
  NOTHING` + winning-row replay). `correct`/`reconcile`/`rebuild` routes require
  `Idempotency-Key` (resource-id-bound hash) + concurrent-winner replay.
- **Determinism**: a window's aggregate is a pure function of the events + corrections
  whose `event_time` falls in it (sum/max/last/unique_count) — never ingest order — so
  a rebuild reproduces stored aggregates, a replay never double-counts, and late/
  out-of-order events recompute their window and bump a late counter. Reconciliation
  independently recomputes and flags any drift.
- **Fail-closed quota**: combines the #871 entitlement limit with an authoritative live
  usage recompute over the immutable events (never a stale aggregate); a hard quota
  denies when usage is unavailable. Entitlement is not permission.
- **Privacy**: numeric-only quantity + a bounded, structurally-admitted dimension map
  (no PII, no raw payloads); domain event + audit payloads never carry the operator's
  free-text correction reason. Meter keys/aggregation/bounds resolve against the #874
  single source; an unknown meter fails closed.
- **API** under `/api/v1/usage-metering` (events, aggregates, quota, corrections,
  reconciliation, aggregation rebuild/status) + OpenAPI/AsyncAPI; jobs
  `usage-metering:aggregate` and `usage-metering:purge`; operator UI at
  `/admin/usage-metering`; `usage_metering.events` registered with data_lifecycle.
