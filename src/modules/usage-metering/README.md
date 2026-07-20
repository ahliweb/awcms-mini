# usage_metering

The **fifth SaaS control-plane module** (Issue #875, epic #868 Wave 1,
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
- **usage_aggregation_cursors** — the worker LEASE + write-once checkpoint
  (`checkpoint_seq` only advances forward — a crashed/replayed run re-processes the
  same page and, because aggregation is recompute-from-source, never double-counts).
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

## Fail-closed quota decision (ADR-0022 §4)

The `usage_aggregate` port's `getQuotaDecision` combines #871's fail-closed
`effective_entitlement` limit with the **authoritative** current-window usage —
recomputed **live** from the immutable events, never a stale materialized
aggregate — so a lagging worker can never let a hard quota over-admit. When the
recompute cannot run, a hard quota **denies** (`usage_unavailable`). Entitlement
is not permission: a positive decision is a commercial fact, never an
authorization.

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
