-- Issue #879 (epic #868 SaaS control plane, Wave 2, ADR-0022 §5 HIGH-2) —
-- catalog "publish vs commercial approval" maker/checker. Before this migration,
-- `offers.publish` was UNILATERAL: a single operator could take a draft offer
-- version straight to a public, immutable commercial artifact with no independent
-- commercial sign-off. The prior SoD rule paired `offers.publish ↔ offers.retire`,
-- which never blocked the publish path itself (publish is not a high-risk action,
-- so the SoD chokepoint never ran there).
--
-- New model: an offer version must be COMMERCIALLY APPROVED (high-risk `approve`
-- action, by a DIFFERENT actor) BEFORE it can be published. The SoD rule
-- `service_catalog.publish_vs_commercial_approve` (`offers.publish ↔
-- offers.approve`) blocks the same actor from approving and publishing. Approval
-- happens while the version is still `draft` (a draft->draft UPDATE, permitted by
-- the existing immutability trigger); `commercial_approved_*` then freeze on
-- publish (added to the out-of-draft frozen set) and are write-once during draft.

ALTER TABLE awcms_mini_service_catalog_plan_versions
  ADD COLUMN IF NOT EXISTS commercial_approved_by uuid,
  ADD COLUMN IF NOT EXISTS commercial_approved_at timestamptz;

-- Rewrite the version immutability guard: add the commercial-approval provenance
-- to the out-of-draft frozen set, and enforce write-once during draft.
CREATE OR REPLACE FUNCTION awcms_mini_service_catalog_guard_version_immutability()
RETURNS trigger AS $$
BEGIN
  IF NOT (
       (OLD.status = 'draft'     AND NEW.status IN ('draft', 'published'))
    OR (OLD.status = 'published' AND NEW.status IN ('published', 'retired'))
    OR (OLD.status = 'retired'   AND NEW.status IN ('retired', 'archived'))
    OR (OLD.status = 'archived'  AND NEW.status = 'archived')
  ) THEN
    RAISE EXCEPTION 'service_catalog: illegal offer-version status transition % -> % (versions never move backward; corrections require a new version)', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.currency <> OLD.currency
       OR NEW.market IS DISTINCT FROM OLD.market
       OR NEW.trial_enabled <> OLD.trial_enabled
       OR NEW.trial_days IS DISTINCT FROM OLD.trial_days
       OR NEW.available_from IS DISTINCT FROM OLD.available_from
       OR NEW.available_to IS DISTINCT FROM OLD.available_to
       OR NEW.version <> OLD.version
       OR NEW.plan_id <> OLD.plan_id
       OR NEW.offer_hash IS DISTINCT FROM OLD.offer_hash
       OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.published_by IS DISTINCT FROM OLD.published_by
       OR NEW.commercial_approved_at IS DISTINCT FROM OLD.commercial_approved_at
       OR NEW.commercial_approved_by IS DISTINCT FROM OLD.commercial_approved_by THEN
      RAISE EXCEPTION 'service_catalog: plan version % is % and its published content/provenance is immutable (corrections require a new version)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Commercial approval is write-once even while still in draft: it can go
  -- NULL -> value exactly once and is then frozen (a re-approval by a different
  -- actor cannot overwrite the recorded approver).
  IF OLD.commercial_approved_at IS NOT NULL
     AND (NEW.commercial_approved_at IS DISTINCT FROM OLD.commercial_approved_at
          OR NEW.commercial_approved_by IS DISTINCT FROM OLD.commercial_approved_by) THEN
    RAISE EXCEPTION 'service_catalog: plan version % commercial-approval provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('retired', 'archived') THEN
    IF NEW.retired_at IS DISTINCT FROM OLD.retired_at
       OR NEW.retired_by IS DISTINCT FROM OLD.retired_by THEN
      RAISE EXCEPTION 'service_catalog: plan version % retirement provenance is immutable', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New CHECKER permission (commercial approval).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('service_catalog', 'offers', 'approve', 'Commercially approve (CHECKER) a draft offer version so it may be published — a DIFFERENT actor than the publisher (SoD publish_vs_commercial_approve) + step-up.')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
