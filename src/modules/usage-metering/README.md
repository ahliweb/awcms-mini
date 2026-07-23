# usage_metering

The **third SaaS control-plane module** (Issue #875, epic #868 Wave 1,
**ADR-0022**) — the provider-neutral **metering foundation**. Owning modules emit
reviewed, **numeric-only** meter EVENTS (idempotent, privacy-minimized) in their
OWN commit through the transaction-safe **`usage_append`** port; an async,
resumable worker **deterministically** materializes usage WINDOWS from the
immutable events plus signed CORRECTIONS; a reconciliation pass recomputes
windows from the immutable source and flags drift; and the read-only
**`usage_aggregate`** port exposes effective usage plus a fail-closed quota
decision that billing (#876) reads. NOT subscription/invoice pricing (#876) and
NOT application telemetry.

It is a **tenant-scoped control-plane module**: every table is `tenant_id` +
`ENABLE` + `FORCE ROW LEVEL SECURITY`, with a policy whose predicate is **always
and only** `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022
§6 — no soft super-tenant). Admitted as an **Official Optional Business
Foundation**, opt-in per tenant, `defaultTenantState: "disabled"`. Administration
is platform/billing-operator only + default-deny.

## No PII / no raw payloads (ADR-0022 §3/§8)

A usage event stores an exact numeric `quantity` (**bigint — never float**) plus
a **bounded** map of admitted dimensions (short scalar keys/values only, gated by
`domain/dimension-admission.ts`) — never raw request bodies, documents, secrets,
or arbitrary JSON. Meter keys, aggregation semantics, bounds, and signed-correction
admissibility all resolve against the **#874 single source**
(`_shared/saas-contract-registry.ts`); an unknown meter fails closed.

## Idempotency identity (counted once)

A producer event's identity binds `(tenant, producer, meter, source_event_id,
source_version)` via a UNIQUE index. A duplicate producer event (same 5-tuple) is
counted **once**: the append port INSERTs `ON CONFLICT DO NOTHING RETURNING` and
replays the winning row. Corrections carry their own idempotency identity.

## Immutability / determinism (ADR-0022 §9)

- **usage_events / usage_corrections** — fully **append-only** (no UPDATE/DELETE):
  the immutable source of truth. A decrease is a signed correction, never an edit;
  a correction LINKS to the original event and never mutates it.
- **usage_aggregates** — a deterministic **materialization** reproducible from the
  immutable events+corrections (a rebuild reproduces the stored value +
  `content_hash`). Window identity is frozen; `source_watermark` only advances;
  `window_closed` is one-way; never hard-deleted.
- **usage_aggregation_cursors** — the worker LEASE + write-once checkpoint. The
  commit-order floor `checkpoint_xid8` (and the informational `checkpoint_seq`)
  only advance forward — a crashed/replayed run re-processes the same page and,
  because aggregation is recompute-from-source, never double-counts.
- **usage_reconciliation_runs** — append-only immutable evidence.

Enforced by BEFORE triggers (`sql/087`) beneath the application guards AND
least-privilege grant REVOKEs (`sql/088`): the app role never UPDATE/DELETEs the
source, never writes aggregates; the worker never writes events/corrections/runs;
purge (worker-only DELETE) honors legal holds.

## Aggregation semantics (from #874, "only where safe")

`sum` (Σ quantity + Σ signed correction — the only aggregation corrections apply
to), `max` (gauge peak), `last` (latest event by `(event_time, ingest_seq)` total
order), `unique_count` (distinct pseudonymous `unique_dimension`). A window's
aggregate is a PURE function of the events + corrections whose `event_time` falls
in the window — never ingest/received order — so late/out-of-order events just
recompute their (possibly already closed) window deterministically and bump a
late counter, a rebuild reproduces stored aggregates byte-for-byte, and
reconciliation flags any stored aggregate that drifts.

## Commit-order safe watermark + reconciliation backstop

`ingest_seq` is **not commit-ordered** — `nextval` is drawn at INSERT time, not
at COMMIT — so a transaction that drew a lower `ingest_seq` can commit _after_ a
higher one. A cursor keyed on `ingest_seq` could advance past the higher-seq row
and permanently under-count the lower-seq event's window (a billing-input revenue
leak) if no later event re-touched that window and no reconciliation ran.

Since **issue #900** the cursor is keyed on a **commit-ordered `xid8`**, not
`ingest_seq`. Each event/correction is stamped with `ingest_xid8`
(`pg_current_xact_id()`, `sql/099`), and each aggregation pass reads
`safe = pg_snapshot_xmin(pg_current_snapshot())` and drains **only settled rows**
(`ingest_xid8 < safe`) from the floor `checkpoint_xid8` upward. Because no
in-flight or future transaction can ever have an `xid8` below `safe`, a
lower-order producer that commits late is always still at/above the floor and is
picked up on a later pass — the cursor **structurally** never skips it.
`checkpoint_seq` is kept as an informational high-water only. A long-running
transaction merely delays newer rows behind it (conservative — never an
under-count). See `application/aggregation-engine.ts`.

Two further backstops remain as defence-in-depth, and the second is still a hard
operational requirement:

1. **Recompute-from-source** — a window is never incrementally accumulated;
   `recomputeWindow` re-reads the _entire_ window by `event_time`, so any later
   event/correction touching the same window pulls a late-committed row back in
   and corrects the value.
2. **Scheduled reconciliation (REQUIRED)** — `runReconciliation`
   (`POST /api/v1/usage-metering/reconciliation`, or an operator schedule)
   independently recomputes each window from the immutable source and records
   `missing_count` / `drift_count` on `awcms_mini_usage_reconciliation_runs`.
   This is the authoritative safety net for any residual drift (e.g. a manual
   data fix). **Deployments MUST run reconciliation on a schedule (e.g. hourly
   for `hour`/`day` windows, daily for `month`) and MUST alarm on
   `missing_count > 0` or `drift_count > 0`** — a persistent non-zero count means
   a window is under-counted and needs a rebuild
   (`POST /api/v1/usage-metering/aggregation/rebuild`). Billing must not be
   finalized (#876) from windows a recent reconciliation has not confirmed
   consistent.

## Fail-closed quota decision (ADR-0022 §4)

The `usage_aggregate` port's `getQuotaDecision` combines #871's fail-closed
`effective_entitlement` limit with the **authoritative** current-window usage —
recomputed **live** from the immutable events, never a stale materialized
aggregate — so a lagging worker can never let a hard quota over-admit. When the
recompute cannot run, a hard quota **denies** (`usage_unavailable`). Entitlement
is not permission: a positive decision is a commercial fact, never an
authorization.

**Bounded recompute (Issue #901).** A naive live recompute reads the _entire_
reset window from source on every call — `O(events-per-reset-window)`, i.e.
`O(events-per-month)` for a `monthly` reset on a high-volume meter. Instead the
reset window is **decomposed** one calendar level finer (`month`→`day`,
`day`→`hour`; an `hour` reset is already small):

- **Settled prefix** (`sub_end + 1h grace ≤ now`, so no in-grace late event can
  still land): read the worker's **materialized sub-aggregates** — an indexed
  `O(sub-windows)` lookup (≤ 31 day rows), never `O(events)`. A settled
  sub-window whose aggregate is **missing** (worker lag) is never assumed `0`
  (that would under-count → over-admit); it is recomputed from source, bounded
  to that one sub-window, or fails closed.
- **Open tail** (`sub_end + grace > now`): **always** recomputed live from
  source (one bounded read over the contiguous open suffix), so a late event in
  the hot period counts immediately even before it is aggregated.
- **`unique_count`** cannot be decomposed (distinct sets across sub-windows
  overlap → summing double-counts), so it stays a **full** source recompute
  under the same budget. HLL sketches are out of scope.
- **Row budget** `QUOTA_MAX_SOURCE_ROWS` (100 000): every source read (open tail
  - settled-missing fallback + full `unique_count`) is capped via a `LIMIT
budget+1` tripwire — never silently truncated (truncation under-counts).
    Exceeding it fails closed (`usage_unavailable` → a hard quota denies).

The settled sub-aggregate lookup rides the existing
`awcms_mini_usage_aggregates_lookup_idx (tenant_id, meter_key, window_type,
window_start)` — no new index. `combine` merges sub-window contributions per
aggregation: `sum` adds, `max` peaks over non-empty windows, `last` picks the
contribution with the greatest `last_event_time` (event times are disjoint
across sub-windows, so the globally-latest event's window carries its value).
Reconciliation remains the defence-in-depth backstop for the residual
"settled sub-aggregate present but stale beyond the grace window" case.

## API (operator-only, current-tenant context)

- `GET  /api/v1/usage-metering/events` — immutable usage-event timeline (`?meterKey=`).
- `GET  /api/v1/usage-metering/aggregates` — materialized windows + freshness (`?meterKey=`, `?windowType=`).
- `GET  /api/v1/usage-metering/quota?meterKey=` — fail-closed effective quota decision.
- `GET  /api/v1/usage-metering/corrections` · `POST` apply a signed correction/reversal.
- `GET  /api/v1/usage-metering/reconciliation` · `POST` run a reconciliation.
- `POST /api/v1/usage-metering/aggregation/rebuild` · `GET .../status`.

`correct`, `reconcile`, and `rebuild` are high-risk: they require `Idempotency-Key`
and are audited. Events: `awcms-mini.usage-metering.usage.corrected`,
`awcms-mini.usage-metering.usage.reconciled` (v1.0). Jobs:
`bun run usage-metering:aggregate` (drain + materialize), `bun run
usage-metering:purge` (delegated retention purge). Admin UI: `/admin/usage-metering`.

The transaction-safe `usage_append` port lets a producing module record a
reviewed meter event in the SAME commit as its business transaction (the
`usage_events` table is the transactional outbox) — never a direct cross-module
import.

See the `awcms-mini-usage-metering` skill and `docs/adr/0022-*.md`.
