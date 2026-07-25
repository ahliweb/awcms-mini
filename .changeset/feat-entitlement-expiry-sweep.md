---
"awcms-mini": minor
---

feat(tenant-entitlement): add the expiry sweep, and correct the SLO that alerted on a queue with no consumer (#930)

Wave 1 of #930 shipped the `control_plane_entitlement_expired_unswept` gauge and
an SLO on top of it. Nothing ever drained that backlog — no expiry sweep existed
anywhere in the repo — so the alert watched a queue with no consumer and could
only climb. `bun run tenant-entitlement:expiry-sweep` is that consumer:
fleet-wide, bounded per tenant, and running inside each tenant's own RLS context
(ADR-0022 §6b).

**The SLO was also wrong about what it measured, and that mattered more than the
missing job.** It described an unswept backlog as an authorization gap — "the
tenant keeps access it is no longer entitled to" — and paged on it as an
access-control incident. Both halves are false:

- `domain/resolution.ts`'s `assignmentActive()` already returns null once
  `now >= effectiveTo`, so an expired assignment contributes **no grants**
  whether or not a sweep has run. No access is retained.
- `assignOffer` supersedes the incumbent row inside its own transaction, so an
  unswept row does not block re-subscribing to the same plan either.

What it actually measures is bookkeeping drift: operator listings, commercial
reporting, and the entitlement projections all read `status`. Severities are
lowered to `info`/`warning` accordingly, and the descriptor, the signal
docstring, and the runbook section now say what the number means. A false
severity is not harmless exaggeration — it files routine bookkeeping beside real
breaches, which is how genuine pages start being ignored.

Migration 104 adds the `expired` status and its `expired_at` timestamp with a
both-directions consistency CHECK, extends the transition whitelist from
migration 081 (adding the status alone is not enough — the guard trigger rejects
`active -> expired`, which the integration test caught), makes expiry provenance
write-once, and grants `awcms_mini_worker` UPDATE (never INSERT/DELETE) on the
assignments table.

Two bugs the tests caught before merge, both invisible to review:

- The transition guard rejected `active -> expired`, so the sweep could not have
  worked at all.
- `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` does **not** bound
  an UPDATE. Postgres chose a nested-loop semi-join with the LIMIT subquery on
  the inner side, re-evaluating it per candidate row, so a batch limit of 2
  against 3 expirable rows updated all 3. Since the batch limit is a
  lock-footprint control, a tenant with thousands of expired rows would have
  taken one enormous lock. Replaced with a `MATERIALIZED` CTE joined into the
  UPDATE.

The sweep is proven not to change anyone's effective access: the integration
test captures the set of grant-contributing assignments before and after and
requires it to be identical. Writes run as the real `awcms_mini_worker` role,
so a missing grant fails the suite rather than production.
