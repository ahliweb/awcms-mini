-- Issue #930 (epic #868) — give `tenant_entitlement` an EXPIRED terminal state
-- and let the least-privilege worker role close out expired assignments.
--
-- ## Why this migration exists
--
-- Wave 1 of #930 shipped the `control_plane_entitlement_expired_unswept`
-- gauge and an SLO built on it. Nothing ever drained that backlog: there was
-- no expiry sweep anywhere in the repo, so the alert measured a queue with no
-- consumer and could only ever climb. This migration adds the state the sweep
-- needs; `application/expiry-sweep.ts` adds the consumer.
--
-- ## What an unswept expired assignment actually costs — and what it does not
--
-- Worth stating precisely, because the Wave 1 descriptor got this wrong and
-- called it an access-control incident. It is not one:
--
--   * NOT an authorization problem. `domain/resolution.ts`'s
--     `assignmentActive()` already returns null once `now >= effective_to`,
--     so an expired assignment contributes no grants whether or not a sweep
--     has run. The tenant does not retain access.
--   * NOT a re-subscription blocker. The partial unique index
--     `..._current_key` covers the live slot, but `assignOffer` supersedes the
--     incumbent row inside the same transaction, so an expired row never
--     stands in the way of assigning the same `plan_key` again.
--
-- What it IS: bookkeeping drift. Operator listings, commercial reporting, and
-- the entitlement projections all read `status`, so a fleet full of `active`
-- rows whose windows closed months ago misstates what the platform is
-- actually selling. That is worth fixing on a schedule; it is not worth
-- paging anyone at 03:00, which is why the SLO severity moves with this
-- change.
--
-- ## Why a new status rather than reusing `canceled`
--
-- `canceled` is operator-initiated, terminal, and carries `canceled_by` +
-- `cancel_reason` — writing it from an unattended sweep would forge an
-- operator decision that nobody made, and would be indistinguishable in the
-- audit trail from a real cancellation. `superseded_at` is equally wrong: it
-- means "replaced by a newer offer version", and nothing replaced anything
-- here. `expired` says what happened: the window closed on its own.
--
-- ## Authorization behaviour is deliberately unchanged
--
-- `assignmentActive()` requires `status = 'active'`, so a row moving to
-- `expired` goes from "no grants (window closed)" to "no grants (not
-- active)". The effective entitlement a tenant resolves is byte-identical
-- before and after a sweep — the sweep records reality, it does not alter it.
-- `tests/integration/tenant-entitlement-expiry-sweep.integration.test.ts`
-- pins exactly that, because a sweep that silently changed anyone's access
-- would be a far worse bug than the drift it fixes.

ALTER TABLE awcms_mini_tenant_entitlement_assignments
  DROP CONSTRAINT IF EXISTS awcms_mini_tenant_entitlement_assignments_status_check;

ALTER TABLE awcms_mini_tenant_entitlement_assignments
  ADD CONSTRAINT awcms_mini_tenant_entitlement_assignments_status_check
    CHECK (status IN ('active', 'suspended', 'canceled', 'expired'));

ALTER TABLE awcms_mini_tenant_entitlement_assignments
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

-- Same shape as the cancel consistency check: the status and its timestamp
-- can never disagree, in either direction.
ALTER TABLE awcms_mini_tenant_entitlement_assignments
  DROP CONSTRAINT IF EXISTS awcms_mini_tenant_entitlement_assignments_expire_consistency_check;

ALTER TABLE awcms_mini_tenant_entitlement_assignments
  ADD CONSTRAINT awcms_mini_tenant_entitlement_assignments_expire_consistency_check
    CHECK ((status = 'expired') = (expired_at IS NOT NULL));

-- The sweep's selection predicate. Migration 103 added
-- `(tenant_id, status, effective_to)` for the READ-side gauge; this partial
-- index serves the sweep's write-side scan, which only ever looks at rows
-- still marked active with a closed window.
CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_assignments_expirable_idx
  ON awcms_mini_tenant_entitlement_assignments (tenant_id, effective_to)
  WHERE status = 'active' AND effective_to IS NOT NULL;

-- The status guard from migration 081 is a WHITELIST of legal transitions, so
-- adding a status to the CHECK above is not enough on its own: without this the
-- sweep fails with `illegal assignment status transition active -> expired`.
-- (Found by the integration test, not by reading the schema — which is the
-- argument for the test.)
--
-- Three transitions are added, and no more:
--
--   * `active -> expired`   — the sweep itself.
--   * `expired -> expired`  — a no-status-change UPDATE on an expired row. This
--     one is load-bearing: `assignOffer` supersedes the incumbent row (setting
--     `superseded_at`) whenever it is not canceled, and an expired row is still
--     supersedable. Omitting this would break re-subscribing to a plan whose
--     previous assignment had been swept.
--   * `expired -> canceled` — an operator formally cancelling a subscription
--     that had already lapsed. Cheap to allow, and forbidding it would newly
--     break an existing operator action for swept rows.
--
-- Deliberately NOT allowed: `expired -> active` or `expired -> suspended`.
-- Resurrecting a lapsed entitlement in place would let a bookkeeping job's
-- output be reversed into a grant; a new subscription is a NEW assignment.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_entitlement_guard_assignment_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'canceled' THEN
    RAISE EXCEPTION 'tenant_entitlement: assignment % is canceled and immutable (entitlement loss is a terminal state, never re-opened or edited)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.plan_key <> OLD.plan_key
     OR NEW.offer_version <> OLD.offer_version
     OR NEW.offer_hash <> OLD.offer_hash
     OR NEW.currency <> OLD.currency
     OR NEW.source <> OLD.source
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'tenant_entitlement: assignment % identity/offer columns are immutable (an upgrade/downgrade is a new assignment)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
       (OLD.status = 'active'    AND NEW.status IN ('active', 'suspended', 'canceled', 'expired'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('suspended', 'active', 'canceled'))
    OR (OLD.status = 'expired'   AND NEW.status IN ('expired', 'canceled'))
  ) THEN
    RAISE EXCEPTION 'tenant_entitlement: illegal assignment status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Expiry provenance is write-once, same rule the supersede provenance
  -- already follows: the moment a window was observed closed is a fact, not a
  -- field to be revised on a later pass.
  IF OLD.expired_at IS NOT NULL
     AND NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
    RAISE EXCEPTION 'tenant_entitlement: assignment % expiry provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.superseded_at IS NOT NULL
     AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
          OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION 'tenant_entitlement: assignment % supersede provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The sweep runs unattended as `awcms_mini_worker` (`getWorkerDatabaseClient()`),
-- which migration 103 granted SELECT on this table for the read-only fleet
-- sweep. Closing out an expired assignment is a WRITE, so it needs UPDATE too.
--
-- UPDATE only, and deliberately not INSERT/DELETE: the sweep may only move an
-- existing row to a terminal state. It must never create an entitlement (that
-- is a commercial decision, made through the audited assign path) nor destroy
-- one (assignments are the evidence trail for what a tenant was sold).
GRANT UPDATE ON awcms_mini_tenant_entitlement_assignments TO awcms_mini_worker;
