-- Issue #879 (epic #868 SaaS control plane, Wave 2, ADR-0022 §5 CRITICAL-1) —
-- REAL maker/checker for refunds: split refund CREATION (maker) from refund
-- APPROVAL (checker). Before this migration a single operator could `requestRefund`
-- and the money-out (outbox dispatch to the provider) was enqueued in the SAME
-- transaction — no independent second actor. That is not a maker/checker control;
-- the previous SoD rule paired `provider_accounts.configure ↔ refunds.create`,
-- which fired only at `configure` (a high-risk action) and NEVER at the actual
-- refund path (`create` is not a high-risk action, so the SoD chokepoint never
-- ran there).
--
-- New model (mirrors `subscription_billing.invoice_create_vs_issue`, the proven
-- maker/checker):
--   1. `requestRefund` (action `create`, MAKER) inserts a refund in status
--      `requested` and enqueues NOTHING — no provider dispatch yet.
--   2. `approveRefund` (action `approve`, CHECKER, HIGH-RISK) — a DIFFERENT actor
--      transitions `requested -> approved` and ONLY THEN enqueues the outbox
--      dispatch. Because `approve` IS a high-risk action, the SoD chokepoint
--      (`access-guard.ts` -> `high-risk-sod-guard.ts`) runs here; the new SoD
--      rule `payment_gateway.refund_create_vs_approve` (`refunds.create ↔
--      refunds.approve`) blocks an actor who ALSO holds `refunds.create` — money
--      only ever leaves after a second, distinct actor approves.
--
-- Refund state machine becomes: requested -> approved -> pending ->
-- {succeeded, failed} (plus requested/approved -> failed for a rejected/failed
-- request). `approved_by`/`approved_at` are WRITE-ONCE and set only on the
-- `requested -> approved` transition (trigger-enforced, forward-legal).

ALTER TABLE awcms_mini_payment_gateway_refunds
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Widen the status / previous_status CHECK to include `approved`.
ALTER TABLE awcms_mini_payment_gateway_refunds
  DROP CONSTRAINT IF EXISTS awcms_mini_payment_gateway_refunds_status_check;
ALTER TABLE awcms_mini_payment_gateway_refunds
  ADD CONSTRAINT awcms_mini_payment_gateway_refunds_status_check
    CHECK (status IN ('requested', 'approved', 'pending', 'succeeded', 'failed'));

ALTER TABLE awcms_mini_payment_gateway_refunds
  DROP CONSTRAINT IF EXISTS awcms_mini_payment_gateway_refunds_previous_status_check;
ALTER TABLE awcms_mini_payment_gateway_refunds
  ADD CONSTRAINT awcms_mini_payment_gateway_refunds_previous_status_check
    CHECK (previous_status IS NULL OR previous_status IN ('requested', 'approved', 'pending', 'succeeded', 'failed'));

-- The live-refund partial unique (at most one in-flight refund per intent) must
-- now also cover `approved` — an approved-but-not-yet-dispatched refund is still
-- live and must block a concurrent second request (double-refund guard, sql/093).
DROP INDEX IF EXISTS awcms_mini_payment_gateway_refunds_live_intent_key;
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_refunds_live_intent_key
  ON awcms_mini_payment_gateway_refunds (tenant_id, intent_id)
  WHERE status IN ('requested', 'approved', 'pending');

-- Rewrite the forward-legal immutability trigger to (a) allow the new
-- `requested -> approved` and `approved -> {pending, failed}` edges, and (b) make
-- `approved_by`/`approved_at` write-once: they are set exactly on the transition
-- INTO `approved` and are frozen thereafter (defence in depth with the app layer).
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_refund_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    RAISE EXCEPTION 'payment_gateway: refund % identity (tenant/intent/currency/amount) and created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'payment_gateway: refund % result is write-once (terminal status % is frozen)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Approval provenance is write-once: set only when entering `approved`, and
  -- never rewritten afterward.
  IF OLD.approved_at IS NOT NULL
     AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
          OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'payment_gateway: refund % approval provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'requested' AND NEW.status IN ('approved', 'failed'))
      OR (OLD.status = 'approved'  AND NEW.status IN ('pending', 'failed'))
      OR (OLD.status = 'pending'   AND NEW.status IN ('succeeded', 'failed'))
    ) THEN
      RAISE EXCEPTION 'payment_gateway: illegal refund status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'payment_gateway: refund % version must advance by exactly one on a transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- Entering `approved` requires the approver provenance in the same write.
    IF NEW.status = 'approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
      RAISE EXCEPTION 'payment_gateway: refund % must record approved_by/approved_at when approved', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New CHECKER permission. Note the CORRECTED description on `refunds.create`
-- (the old text over-claimed "SoD/step-up" on the maker step): the maker only
-- REQUESTS; approval + dispatch is the separate, SoD/step-up-gated checker step.
UPDATE awcms_mini_permissions
  SET description = 'Request (MAKER) a refund where supported — mandatory reason + idempotency. Does NOT dispatch money; a separate approver must approve first.'
  WHERE module_key = 'payment_gateway' AND activity_code = 'refunds' AND action = 'create';

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('payment_gateway', 'refunds', 'approve', 'Approve (CHECKER) a requested refund — a DIFFERENT actor than the requester (SoD refund_create_vs_approve) + step-up; only then is the provider dispatch enqueued (money-out).')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
