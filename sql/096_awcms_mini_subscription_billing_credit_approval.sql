-- Issue #879 (epic #868 SaaS control plane, Wave 2, ADR-0022 §5 CRITICAL-1) —
-- REAL maker/checker for credit notes. Before this migration, `creditInvoice`
-- both created the credit note AND applied it to the invoice balance
-- (`addInvoiceCredited`) in the SAME transaction, with NO SoD rule at all — a
-- single operator could reduce any tenant's owed balance unilaterally.
--
-- New model (mirrors the refund and invoice maker/checker):
--   1. `creditInvoice` (action `create`, MAKER) inserts a credit note in status
--      `pending_approval`. The invoice `credited_minor` balance is NOT touched.
--   2. `approveCredit` (action `approve`, CHECKER, HIGH-RISK) — a DIFFERENT actor
--      transitions `pending_approval -> applied` and ONLY THEN applies the credit
--      to the invoice balance. Because `approve` is high-risk, the SoD chokepoint
--      runs; rule `subscription_billing.credit_create_vs_approve`
--      (`credits.create ↔ credits.approve`) blocks a single actor from doing both.
--
-- `approved_by`/`approved_at` are WRITE-ONCE, set only on the approval transition.
-- A credit may also be `rejected` (terminal, never applied).

ALTER TABLE awcms_mini_subscription_billing_credit_notes
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending_approval',
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE awcms_mini_subscription_billing_credit_notes
  DROP CONSTRAINT IF EXISTS awcms_mini_subscription_billing_credit_notes_status_check;
ALTER TABLE awcms_mini_subscription_billing_credit_notes
  ADD CONSTRAINT awcms_mini_subscription_billing_credit_notes_status_check
    CHECK (status IN ('pending_approval', 'applied', 'rejected'));

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_credit_notes_status_idx
  ON awcms_mini_subscription_billing_credit_notes (tenant_id, invoice_id, status);

-- The table was previously insert-only (no UPDATE path). The maker/checker split
-- introduces exactly ONE legal UPDATE — the approval/rejection transition — so a
-- trigger now enforces: identity/amount immutable; forward-legal
-- (pending_approval -> {applied, rejected} only); approval provenance write-once.
CREATE OR REPLACE FUNCTION awcms_mini_subscription_billing_guard_credit_note_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.invoice_line_id IS DISTINCT FROM OLD.invoice_line_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    RAISE EXCEPTION 'subscription_billing: credit note % identity/amount is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('applied', 'rejected') THEN
    RAISE EXCEPTION 'subscription_billing: credit note % is terminal (status % is frozen)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (OLD.status = 'pending_approval' AND NEW.status IN ('applied', 'rejected')) THEN
      RAISE EXCEPTION 'subscription_billing: illegal credit note status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'applied' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
      RAISE EXCEPTION 'subscription_billing: credit note % must record approved_by/approved_at when applied', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.approved_at IS NOT NULL
     AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
          OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'subscription_billing: credit note % approval provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- sql/091 installed a blanket append-only trigger (rejects ALL UPDATE + DELETE).
-- The maker/checker split needs the single approval UPDATE, so replace that
-- trigger: a BEFORE UPDATE guard that permits ONLY the approval/rejection
-- transition (above), plus a BEFORE DELETE guard that still rejects deletes.
DROP TRIGGER IF EXISTS awcms_mini_subscription_billing_credit_notes_append_only
  ON awcms_mini_subscription_billing_credit_notes;

CREATE TRIGGER awcms_mini_subscription_billing_credit_notes_immutability
  BEFORE UPDATE ON awcms_mini_subscription_billing_credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_credit_note_immutability();

CREATE TRIGGER awcms_mini_subscription_billing_credit_notes_no_delete
  BEFORE DELETE ON awcms_mini_subscription_billing_credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_append_only();

-- sql/091 REVOKEd UPDATE on this table (it was insert-only). The maker/checker
-- split introduces exactly one legal UPDATE (the approval transition), guarded by
-- the trigger above, so restore UPDATE for the app role while keeping DELETE
-- revoked (never hard-deleted).
GRANT UPDATE ON awcms_mini_subscription_billing_credit_notes TO awcms_mini_app;

-- CHECKER permission + corrected MAKER description.
UPDATE awcms_mini_permissions
  SET description = 'Create (MAKER) a credit note in pending_approval — does NOT reduce the invoice balance; a separate approver must apply it.'
  WHERE module_key = 'subscription_billing' AND activity_code = 'credits' AND action = 'create';

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('subscription_billing', 'credits', 'approve', 'Approve (CHECKER) a pending credit note — a DIFFERENT actor than the creator (SoD credit_create_vs_approve) + step-up; only then is the credit applied to the invoice balance.')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
