-- Issue #870 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `service_catalog` module schema: versioned, provider-neutral SaaS plans
-- with immutable published offer versions, feature/module entitlement
-- grants, usage quotas, exact minor-unit prices, availability/trial/market
-- metadata, and a draft -> validate -> publish -> retire lifecycle.
--
-- ## Placement (ADR-0022 §1/§3) — control-plane GLOBAL data, no tenant_id
--
-- Every catalog table here is GLOBAL (no `tenant_id`, no RLS) — a plan/offer
-- is identical for every tenant by design (operators sell the SAME catalog to
-- all tenants), exactly the reviewed RLS-exempt reasoning
-- `awcms_mini_permissions`/`awcms_mini_reference_value_sets`/`awcms_mini_idn_
-- admin_regions` already use (doc 04 §RLS standard, ADR-0021 §8). All six
-- tables are registered explicitly in `scripts/security-readiness.ts`'s
-- `RLS_FREE_TABLES` and `ALLOWED_GLOBAL_TABLE_GRANTS` (kept in lock-step with
-- this migration).
--
-- ## Medium-1 (ADR-0022 §3) — RLS-free must NOT mean "the whole catalog is
-- tenant-readable"
--
-- ADR-0022 §3 (Medium-1) is explicit: the global RLS-free grant applies ONLY
-- to `published` + effective-dated offer rows; `draft`/`retired` working data
-- and operator-only INTERNAL prices must live in PROTECTED tables/columns,
-- never blanket RLS-free. This schema enforces that with a TWO-TIER split:
--
--   TIER A — operator authoring/lifecycle (tables 1-5, `..._plans`,
--   `..._plan_versions`, `..._version_features/quotas/prices`). Holds the full
--   working set: every lifecycle state (draft/published/retired/archived) AND
--   `visibility='internal'` price components. Mutated ONLY by the
--   platform-operator-only, default-deny `service_catalog.*` endpoints
--   (permission is the protection, ADR-0022 §3 "RLS/permission"; the single
--   app DB role serves both operator and tenant sessions, so DB-level actor
--   separation is not possible for a global table — tenant-plane code NEVER
--   queries these, enforced by `tests/unit/module-boundary.test.ts`).
--
--   TIER B — the tenant-readable PUBLISHED PROJECTION (table 6,
--   `..._published_offers`). Written ONLY at publish time, it PHYSICALLY
--   cannot contain a draft/retired-authoring row or an internal-price column:
--   it carries only the published version + the PUBLIC price subset. This is
--   the DB-level "published only" surface the `service_catalog_read`
--   capability (ADR-0022 §2) reads — the single thing a tenant-plane module
--   ever sees. Corrections publish a NEW version (a new immutable projection
--   row); the prior row stays readable forever.
--
-- ## Immutability (ADR-0022 §3, AC "published versions IMMUTABLE")
--
-- Published offer content is frozen: two BEFORE triggers below reject any
-- edit of a non-draft version's commercial content and any write to a
-- non-draft version's feature/quota/price rows — defence in depth beneath the
-- application-layer guard (`service-catalog/application/*`), which is what the
-- mutation test in `tests/unit/service-catalog-lifecycle.test.ts` proves is
-- real. Corrections are a NEW version, never an in-place edit.
--
-- ## Exact money (AC "no floating-point amount storage")
--
-- Price amounts are stored as `amount_minor bigint` — EXACT minor currency
-- units (e.g. cents), never `float`/`double`/`numeric`-with-scale-drift.
--
-- No secret/provider credential is ever stored here (ADR-0022 §3/§6).

-- =====================================================================
-- TIER A — operator authoring/lifecycle (global, permission-protected)
-- =====================================================================

-- 1. `awcms_mini_service_catalog_plans` — a stable plan identity (the thing an
--    operator sells). `plan_key` is immutable once created; a plan owns many
--    versions. `status` is the coarse plan-line state (`active`/`archived`);
--    version-level lifecycle lives on table 2.
CREATE TABLE IF NOT EXISTS awcms_mini_service_catalog_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key text NOT NULL,
  name text NOT NULL,
  description text,
  plan_type text NOT NULL DEFAULT 'subscription',
  status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_service_catalog_plans_key_key UNIQUE (plan_key),
  CONSTRAINT awcms_mini_service_catalog_plans_key_format_check
    CHECK (plan_key ~ '^[a-z][a-z0-9_]*$' AND length(plan_key) <= 100),
  CONSTRAINT awcms_mini_service_catalog_plans_name_length_check
    CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT awcms_mini_service_catalog_plans_type_check
    CHECK (plan_type IN ('subscription', 'addon', 'bundle', 'custom')),
  CONSTRAINT awcms_mini_service_catalog_plans_status_check
    CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_plans_status_idx
  ON awcms_mini_service_catalog_plans (status);

-- 2. `awcms_mini_service_catalog_plan_versions` — one immutable-once-published
--    offer version per (plan, version). `status` drives the lifecycle
--    draft -> published -> retired -> archived. `offer_hash` is set at publish
--    (content fingerprint, reproducibility + idempotency). Effective-dating is
--    `available_from`/`available_to`.
CREATE TABLE IF NOT EXISTS awcms_mini_service_catalog_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES awcms_mini_service_catalog_plans (id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  market text,
  trial_enabled boolean NOT NULL DEFAULT false,
  trial_days integer,
  available_from timestamptz,
  available_to timestamptz,
  notes text,
  offer_hash text,
  published_at timestamptz,
  published_by uuid,
  retired_at timestamptz,
  retired_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_service_catalog_plan_versions_plan_version_key
    UNIQUE (plan_id, version),
  CONSTRAINT awcms_mini_service_catalog_plan_versions_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_service_catalog_plan_versions_status_check
    CHECK (status IN ('draft', 'published', 'retired', 'archived')),
  CONSTRAINT awcms_mini_service_catalog_plan_versions_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_service_catalog_plan_versions_market_check
    CHECK (market IS NULL OR market ~ '^[A-Za-z0-9][A-Za-z0-9_\-]{0,31}$'),
  CONSTRAINT awcms_mini_service_catalog_plan_versions_trial_days_check
    CHECK (trial_days IS NULL OR (trial_days >= 0 AND trial_days <= 3650)),
  CONSTRAINT awcms_mini_service_catalog_plan_versions_available_range_check
    CHECK (available_to IS NULL OR available_from IS NULL OR available_to > available_from)
);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_plan_versions_plan_idx
  ON awcms_mini_service_catalog_plan_versions (plan_id, version DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_plan_versions_status_idx
  ON awcms_mini_service_catalog_plan_versions (status);

-- At most ONE draft version per plan (the single working version). Publishing
-- it frees the slot so a later correction can start a new draft (version N+1).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_service_catalog_plan_versions_one_draft_idx
  ON awcms_mini_service_catalog_plan_versions (plan_id)
  WHERE status = 'draft';

-- 3. `awcms_mini_service_catalog_version_features` — feature grant OR whole-
--    module entitlement declaration per version. `feature_kind='module'` means
--    `feature_key` is a real `listModules()` module key; `feature_kind='feature'`
--    means it is a registry feature key (`ModuleDescriptor.serviceCatalog.
--    contributesFeatureKeys`). Unknown keys are rejected at the application
--    layer (fail-closed, Issue #870) — the DB stores only the validated key.
CREATE TABLE IF NOT EXISTS awcms_mini_service_catalog_version_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL
    REFERENCES awcms_mini_service_catalog_plan_versions (id) ON DELETE CASCADE,
  feature_kind text NOT NULL,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_service_catalog_version_features_key
    UNIQUE (version_id, feature_kind, feature_key),
  CONSTRAINT awcms_mini_service_catalog_version_features_kind_check
    CHECK (feature_kind IN ('feature', 'module')),
  CONSTRAINT awcms_mini_service_catalog_version_features_key_format_check
    CHECK (feature_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(feature_key) <= 120),
  CONSTRAINT awcms_mini_service_catalog_version_features_metadata_size_check
    CHECK (length(metadata::text) <= 4000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_version_features_version_idx
  ON awcms_mini_service_catalog_version_features (version_id);

-- 4. `awcms_mini_service_catalog_version_quotas` — usage quota/limit per meter
--    per version, with unit + reset policy. `meter_key` is validated against
--    the static meter registry (fail-closed). `is_unlimited` XORs with a
--    numeric `limit_value` (exact integer, never float).
CREATE TABLE IF NOT EXISTS awcms_mini_service_catalog_version_quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL
    REFERENCES awcms_mini_service_catalog_plan_versions (id) ON DELETE CASCADE,
  meter_key text NOT NULL,
  is_unlimited boolean NOT NULL DEFAULT false,
  limit_value bigint,
  unit text NOT NULL,
  reset_policy text NOT NULL DEFAULT 'none',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_service_catalog_version_quotas_key
    UNIQUE (version_id, meter_key),
  CONSTRAINT awcms_mini_service_catalog_version_quotas_meter_format_check
    CHECK (meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(meter_key) <= 120),
  CONSTRAINT awcms_mini_service_catalog_version_quotas_unit_check
    CHECK (unit ~ '^[a-z][a-z0-9_]*$' AND length(unit) <= 40),
  CONSTRAINT awcms_mini_service_catalog_version_quotas_reset_check
    CHECK (reset_policy IN ('none', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'billing_cycle')),
  CONSTRAINT awcms_mini_service_catalog_version_quotas_limit_check
    CHECK (
      (is_unlimited AND limit_value IS NULL)
      OR (
        NOT is_unlimited AND limit_value IS NOT NULL
        -- Upper bound = JS Number.MAX_SAFE_INTEGER (2^53-1): the app reads
        -- limit_value via Number(...), so an out-of-band bigint would lose
        -- precision silently (Issue #870 review Fix 4). Constraint backs the
        -- write-side validation in domain/plan.ts.
        AND limit_value BETWEEN 0 AND 9007199254740991
      )
    ),
  CONSTRAINT awcms_mini_service_catalog_version_quotas_metadata_size_check
    CHECK (length(metadata::text) <= 4000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_version_quotas_version_idx
  ON awcms_mini_service_catalog_version_quotas (version_id);

-- 5. `awcms_mini_service_catalog_version_prices` — price components per version.
--    `amount_minor` is EXACT minor units (bigint, no float). `visibility`
--    separates tenant-facing `public` prices from operator-only `internal`
--    ones (ADR-0022 §3 Medium-1): only `public` rows are ever copied to the
--    tenant-readable projection (table 6).
CREATE TABLE IF NOT EXISTS awcms_mini_service_catalog_version_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL
    REFERENCES awcms_mini_service_catalog_plan_versions (id) ON DELETE CASCADE,
  component_key text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  interval text NOT NULL DEFAULT 'one_time',
  visibility text NOT NULL DEFAULT 'public',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_service_catalog_version_prices_key
    UNIQUE (version_id, component_key),
  CONSTRAINT awcms_mini_service_catalog_version_prices_component_format_check
    CHECK (component_key ~ '^[a-z][a-z0-9_]*$' AND length(component_key) <= 60),
  CONSTRAINT awcms_mini_service_catalog_version_prices_amount_check
    -- Upper bound = JS Number.MAX_SAFE_INTEGER (2^53-1): amount_minor is read
    -- via Number(...) in the app, so an out-of-band bigint would lose precision
    -- silently (Issue #870 review Fix 4). Backs domain/plan.ts validation.
    CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT awcms_mini_service_catalog_version_prices_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_service_catalog_version_prices_interval_check
    CHECK (interval IN ('one_time', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'usage')),
  CONSTRAINT awcms_mini_service_catalog_version_prices_visibility_check
    CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT awcms_mini_service_catalog_version_prices_metadata_size_check
    CHECK (length(metadata::text) <= 4000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_version_prices_version_idx
  ON awcms_mini_service_catalog_version_prices (version_id);

-- =====================================================================
-- TIER B — tenant-readable PUBLISHED PROJECTION (published-only surface)
-- =====================================================================

-- 6. `awcms_mini_service_catalog_published_offers` — the ONLY table a
--    tenant-plane module ever reads (via `service_catalog_read`, ADR-0022 §2).
--    An immutable snapshot written once at publish, carrying the published
--    version + PUBLIC price subset only (no internal prices, no draft data).
--    `retired_at` is the single field that changes post-insert (set on retire;
--    the row stays readable — "existing published versions remain readable").
CREATE TABLE IF NOT EXISTS awcms_mini_service_catalog_published_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL
    REFERENCES awcms_mini_service_catalog_plan_versions (id),
  plan_key text NOT NULL,
  plan_name text NOT NULL,
  plan_type text NOT NULL,
  version integer NOT NULL,
  currency text NOT NULL,
  market text,
  trial_enabled boolean NOT NULL DEFAULT false,
  trial_days integer,
  effective_from timestamptz,
  effective_to timestamptz,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  quotas jsonb NOT NULL DEFAULT '[]'::jsonb,
  prices jsonb NOT NULL DEFAULT '[]'::jsonb,
  offer_hash text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_service_catalog_published_offers_plan_version_key
    UNIQUE (plan_key, version),
  CONSTRAINT awcms_mini_service_catalog_published_offers_source_key
    UNIQUE (plan_version_id),
  CONSTRAINT awcms_mini_service_catalog_published_offers_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_service_catalog_published_offers_payload_size_check
    CHECK (length(features::text) + length(quotas::text) + length(prices::text) <= 200000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_published_offers_plan_idx
  ON awcms_mini_service_catalog_published_offers (plan_key, version DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_service_catalog_published_offers_active_idx
  ON awcms_mini_service_catalog_published_offers (plan_key)
  WHERE retired_at IS NULL;

-- =====================================================================
-- Immutability triggers (defence in depth beneath the application guard)
-- =====================================================================

-- Two guards in one BEFORE-UPDATE trigger:
--
-- (a) STATUS TRANSITIONS must be forward-legal (Issue #870 review Fix 1,
--     ADR-0022 §3/§11). A version NEVER moves backward — especially back to
--     'draft', which would otherwise re-open a published version's content AND
--     its feature/quota/price rows to edits (the child trigger below keys off
--     status = 'draft'). Allowed: draft->draft (draft edit), draft->published
--     (publish), published->retired (retire), retired->archived (archive), and
--     same-status no-ops. Everything else (any backward move, draft->retired,
--     etc.) is rejected — closing the "SET status='draft' then edit children"
--     bypass a content-only guard would leave open.
-- (b) Once a version has left 'draft', its COMMERCIAL CONTENT is frozen
--     (currency/market/trial/availability/version/plan/offer_hash/notes) —
--     corrections require a NEW version. The retire/archive transitions only
--     move status + their own timestamps, so they pass this check.
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
    -- Content is frozen once out of draft. `published_at`/`published_by` are
    -- included (A4): they are written only at publish time (draft->published,
    -- which bypasses this block since OLD.status='draft'), so freezing them for
    -- any later UPDATE prevents an app-role rewrite of the publish provenance.
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
       OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN
      RAISE EXCEPTION 'service_catalog: plan version % is % and its published content/provenance is immutable (corrections require a new version)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Retirement provenance is frozen ONCE retired/archived (A4). `retired_at`/
  -- `retired_by` are legitimately written at retire time (published->retired,
  -- OLD.status='published', which is not in this set), so this only blocks a
  -- later rewrite of the retirement provenance.
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

CREATE TRIGGER awcms_mini_service_catalog_plan_versions_immutability
  BEFORE UPDATE ON awcms_mini_service_catalog_plan_versions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_service_catalog_guard_version_immutability();

-- Reject any INSERT/UPDATE/DELETE of a feature/quota/price row whose parent
-- version has left draft — a published version's feature/quota/price set is
-- frozen at the DB level, not just in the application service.
--
-- A2 (reparent bypass): on UPDATE, checking only `COALESCE(NEW.version_id,
-- OLD.version_id)` (= NEW on UPDATE) let a row be MOVED OUT of a published
-- version into a draft (`UPDATE ... SET version_id = '<draft>' WHERE version_id
-- = '<published>'` — NEW resolves to the draft, passes). So: (1) forbid
-- changing `version_id` at all on UPDATE, and (2) check BOTH the OLD and NEW
-- parent's status — a write is allowed only when every parent touched is a
-- draft.
CREATE OR REPLACE FUNCTION awcms_mini_service_catalog_guard_child_immutability()
RETURNS trigger AS $$
DECLARE
  v_bad_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version_id IS DISTINCT FROM OLD.version_id THEN
    RAISE EXCEPTION 'service_catalog: a feature/quota/price row may not be reparented to another version'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Any parent version this write touches (OLD on UPDATE/DELETE, NEW on
  -- INSERT/UPDATE) must be a draft.
  SELECT status INTO v_bad_status
  FROM awcms_mini_service_catalog_plan_versions
  WHERE id IN (NEW.version_id, OLD.version_id) AND status IS DISTINCT FROM 'draft'
  LIMIT 1;

  IF v_bad_status IS NOT NULL THEN
    RAISE EXCEPTION 'service_catalog: features/quotas/prices of a non-draft version are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_service_catalog_version_features_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON awcms_mini_service_catalog_version_features
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_service_catalog_guard_child_immutability();

CREATE TRIGGER awcms_mini_service_catalog_version_quotas_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON awcms_mini_service_catalog_version_quotas
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_service_catalog_guard_child_immutability();

CREATE TRIGGER awcms_mini_service_catalog_version_prices_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON awcms_mini_service_catalog_version_prices
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_service_catalog_guard_child_immutability();

-- A3: `plan_key` is a stable identity — renaming it after an offer is published
-- would orphan the published projection (old rows keep the old key, tenants
-- reading the old key stop seeing new versions). Documented immutable; enforced
-- here (the app-role has UPDATE on this table for metadata/archive changes).
CREATE OR REPLACE FUNCTION awcms_mini_service_catalog_guard_plan_key_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.plan_key <> OLD.plan_key THEN
    RAISE EXCEPTION 'service_catalog: plan_key is immutable (renaming would orphan published offers)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_service_catalog_plans_key_immutability
  BEFORE UPDATE ON awcms_mini_service_catalog_plans
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_service_catalog_guard_plan_key_immutability();

-- A1: a published-offer projection row is an immutable tenant-visible snapshot.
-- Only `retired_at` may change (set once at retire). Grant-level REVOKE of
-- DELETE is not enough, because publish (INSERT) and retire (UPDATE retired_at)
-- legitimately need write access; the trigger enforces the column-level freeze
-- so an app-role `UPDATE ... SET prices/features/offer_hash` on a published
-- offer is rejected.
CREATE OR REPLACE FUNCTION awcms_mini_service_catalog_guard_published_offer_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id
     OR NEW.plan_key IS DISTINCT FROM OLD.plan_key
     OR NEW.plan_name IS DISTINCT FROM OLD.plan_name
     OR NEW.plan_type IS DISTINCT FROM OLD.plan_type
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.market IS DISTINCT FROM OLD.market
     OR NEW.trial_enabled IS DISTINCT FROM OLD.trial_enabled
     OR NEW.trial_days IS DISTINCT FROM OLD.trial_days
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.features IS DISTINCT FROM OLD.features
     OR NEW.quotas IS DISTINCT FROM OLD.quotas
     OR NEW.prices IS DISTINCT FROM OLD.prices
     OR NEW.offer_hash IS DISTINCT FROM OLD.offer_hash
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'service_catalog: a published offer projection is immutable except retired_at'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_service_catalog_published_offers_immutability
  BEFORE UPDATE ON awcms_mini_service_catalog_published_offers
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_service_catalog_guard_published_offer_immutability();

-- =====================================================================
-- Least-privilege grants for the runtime app role (ADR-0022 §12)
-- =====================================================================
--
-- `awcms_mini_app` auto-inherits SELECT/INSERT/UPDATE/DELETE on every new
-- table (migration 045's `ALTER DEFAULT PRIVILEGES`). Two tables are
-- write-append-only, so DELETE is revoked to match their real access:
--   - `..._plans`            : never hard-deleted (archive is a status change).
--   - `..._published_offers` : an immutable projection — a published offer is
--                              never deleted (only `retired_at` is set).
-- The app-role grants that remain are asserted verbatim in
-- `scripts/security-readiness.ts`'s `ALLOWED_GLOBAL_TABLE_GRANTS`.
REVOKE DELETE ON awcms_mini_service_catalog_plans FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_service_catalog_published_offers FROM awcms_mini_app;
