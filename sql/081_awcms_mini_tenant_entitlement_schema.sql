-- Issue #871 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `tenant_entitlement` module schema: the SECOND control-plane module and the
-- HEART of the epic. It derives a tenant's EFFECTIVE feature/module/quota
-- access from published service_catalog offers plus platform-operator
-- overrides, and exposes ONE fail-closed enforcement contract
-- (`effective_entitlement`) that the tenant-plane and downstream control-plane
-- modules (#872/#873/#875/#876) consume.
--
-- ## Placement (ADR-0022 §3) — the FIRST tenant-SCOPED control-plane module
--
-- Unlike `service_catalog` (global, RLS-free published catalog), every table
-- here is TENANT-SCOPED: `tenant_id` + `ENABLE` + `FORCE ROW LEVEL SECURITY` +
-- a policy whose predicate is ALWAYS AND ONLY
-- `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022 §6
-- High-1 "no soft super-tenant": the predicate is NEVER extended with an
-- `OR platform-claim` clause — that would be a functional BYPASSRLS that slips
-- past `scripts/security-readiness.ts`'s role-attribute check). A platform
-- operator manages a tenant's entitlements ONLY inside that tenant's
-- `withTenant()` per-tenant context (one tenant per context, each mutation
-- audited) — exactly the §6(a) pattern. `tenant_id` is first in every
-- composite index (doc 04 §Index standard).
--
-- ## Data ownership (ADR-0022 §3)
--
-- `tenant_entitlement` owns these tables; no other module writes them
-- (no-shared-table-write, ADR-0013 §6, gated by
-- `tests/unit/module-boundary.test.ts`). A tenant-plane module NEVER queries
-- them directly — it reads ONLY the `effective_entitlement` capability port
-- (read-only), and RBAC/ABAC/RLS remain the sole authorization authority: a
-- positive commercial entitlement can NEVER grant a permission an actor does
-- not hold (ADR-0022 §4, distinct axis from ABAC default-deny).
--
-- ## Immutability / write-once (ADR-0022 §9, epic pattern #4)
--
-- Entitlement changes are AUDITABLE and reversible only through explicit,
-- one-way transitions — never silent edits or hard deletes:
--   - assignments: identity/offer columns frozen once created; `status`
--     transitions are forward-legal only (a canceled assignment is terminal);
--     supersede/cancel provenance is write-once.
--   - overrides: identity/effect columns frozen once created; revocation is
--     write-once (NULL -> non-null). An expired/revoked override CEASES to
--     apply with no restart (resolution is time-based, read at request time).
--   - evaluation snapshots: fully append-only (no UPDATE/DELETE) — the
--     immutable history of what a tenant's effective entitlement RESOLVED to
--     after each change, backing reproducibility + deterministic cache
--     invalidation.
-- These are enforced by BEFORE triggers (defence in depth beneath the
-- application-layer guards in `application/*`) AND least-privilege grant
-- REVOKEs — a downgrade/suspension changes STATE, it NEVER `DELETE`s tenant
-- data (ADR-0022 §6/§9, AC "entitlement loss does not delete tenant data").
--
-- ## Exact numbers (AC "no floating-point")
--
-- Quota limits are stored as `bigint` EXACT integer units, never float, with
-- an upper bound of JS `Number.MAX_SAFE_INTEGER` (read via `Number(...)`).
--
-- No secret/provider credential is ever stored here (ADR-0022 §3/§6).

-- =====================================================================
-- 1. `awcms_mini_tenant_entitlement_assignments` — a tenant's subscription to
--    a published service_catalog offer version (the base source of grants).
--    Effective-dated (trial/grace windows) and lifecycle-aware (active /
--    suspended / canceled). A newer assignment for the same plan SUPERSEDES
--    the prior current one (the offer version/hash is snapshotted for
--    reproducibility + explanation). `offer_hash` records WHICH offer was
--    assigned, never a recomputed/current value.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_entitlement_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  plan_key text NOT NULL,
  offer_version integer NOT NULL,
  offer_hash text NOT NULL,
  currency text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  reason text,
  status text NOT NULL DEFAULT 'active',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  superseded_at timestamptz,
  superseded_by uuid,
  suspended_at timestamptz,
  suspended_by uuid,
  suspend_reason text,
  resumed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_status_check
    CHECK (status IN ('active', 'suspended', 'canceled')),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_source_check
    CHECK (source IN ('manual', 'subscription', 'trial', 'migration')),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_plan_key_format_check
    CHECK (plan_key ~ '^[a-z][a-z0-9_]*$' AND length(plan_key) <= 100),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_offer_version_check
    CHECK (offer_version >= 1),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_cancel_consistency_check
    CHECK ((status = 'canceled') = (canceled_at IS NOT NULL)),
  CONSTRAINT awcms_mini_tenant_entitlement_assignments_suspend_consistency_check
    CHECK (status <> 'suspended' OR suspended_at IS NOT NULL)
);

-- At most ONE current assignment per (tenant, plan_key): a superseded or
-- canceled row is history, not current — so the partial unique index only
-- covers the live subscription slot. Assigning a new offer version supersedes
-- the current row and inserts a new one (the loser of a concurrent race hits
-- this index and is turned into a clean 409, never a raw unique violation).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_assignments_current_key
  ON awcms_mini_tenant_entitlement_assignments (tenant_id, plan_key)
  WHERE superseded_at IS NULL AND canceled_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_assignments_tenant_idx
  ON awcms_mini_tenant_entitlement_assignments (tenant_id, plan_key);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_assignments_status_idx
  ON awcms_mini_tenant_entitlement_assignments (tenant_id, status);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_assignments_history_idx
  ON awcms_mini_tenant_entitlement_assignments (tenant_id, plan_key, created_at DESC);

ALTER TABLE awcms_mini_tenant_entitlement_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_entitlement_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_entitlement_assignments_tenant_isolation
  ON awcms_mini_tenant_entitlement_assignments
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 2. `awcms_mini_tenant_entitlement_overrides` — a platform-operator override
--    of a single feature/module/quota key: an explicit, reason-bound,
--    optionally time-bound GRANT (add-on) or DENY (restriction). Revocation is
--    write-once. A revoked/expired override stops applying with no restart
--    (resolution reads the effective window at request time).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_entitlement_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  target_kind text NOT NULL,
  target_key text NOT NULL,
  effect text NOT NULL,
  quota_is_unlimited boolean NOT NULL DEFAULT false,
  quota_limit_value bigint,
  quota_unit text,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_kind_check
    CHECK (target_kind IN ('feature', 'module', 'quota')),
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_effect_check
    CHECK (effect IN ('grant', 'deny')),
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_target_key_format_check
    CHECK (target_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(target_key) <= 120),
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_reason_length_check
    CHECK (length(reason) BETWEEN 1 AND 500),
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_source_check
    CHECK (source IN ('manual', 'addon', 'compensation', 'support')),
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- Quota columns are meaningful ONLY for a quota GRANT; every other row must
  -- leave them at their neutral defaults. A quota grant XORs unlimited with an
  -- exact bigint <= Number.MAX_SAFE_INTEGER (read via Number(...), backs the
  -- write-side validation) and always carries a unit.
  CONSTRAINT awcms_mini_tenant_entitlement_overrides_quota_shape_check
    CHECK (
      CASE
        WHEN target_kind = 'quota' AND effect = 'grant' THEN
          (
            (quota_is_unlimited AND quota_limit_value IS NULL)
            OR (NOT quota_is_unlimited AND quota_limit_value IS NOT NULL
                AND quota_limit_value BETWEEN 0 AND 9007199254740991)
          )
          AND quota_unit IS NOT NULL
          AND quota_unit ~ '^[a-z][a-z0-9_]*$'
          AND length(quota_unit) <= 40
        ELSE
          quota_is_unlimited = false
          AND quota_limit_value IS NULL
          AND quota_unit IS NULL
      END
    )
);

-- At most ONE active (non-revoked) override per (tenant, target_kind,
-- target_key) — the deterministic single-decision-per-key invariant the
-- resolver relies on. The application INSERT uses
-- `ON CONFLICT (tenant_id, target_kind, target_key) WHERE revoked_at IS NULL
-- DO NOTHING` against this partial unique index: a concurrent duplicate is a
-- clean 409 (`override_exists`), never a raw 23505 (500).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_overrides_active_key
  ON awcms_mini_tenant_entitlement_overrides (tenant_id, target_kind, target_key)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_overrides_tenant_idx
  ON awcms_mini_tenant_entitlement_overrides (tenant_id, target_kind, target_key);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_overrides_active_idx
  ON awcms_mini_tenant_entitlement_overrides (tenant_id, revoked_at);

ALTER TABLE awcms_mini_tenant_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_entitlement_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_entitlement_overrides_tenant_isolation
  ON awcms_mini_tenant_entitlement_overrides
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 3. `awcms_mini_tenant_entitlement_evaluation_snapshots` — append-only
--    immutable record of the effective entitlement a tenant RESOLVED to right
--    after each change. Backs the "evaluation snapshots/history" AC,
--    reproducibility, and DETERMINISTIC cache invalidation (the same
--    `snapshot_hash` is carried on the emitted domain event). The stored
--    payload is the TENANT-FACING resolved shape only (allowed/limit/source
--    kind) — never operator-only free-text reasons (epic pattern #5: hash /
--    expose only what is exposed, no oracle).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_entitlement_evaluation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL,
  trigger_event_type text,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  modules jsonb NOT NULL DEFAULT '[]'::jsonb,
  quotas jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot_hash text NOT NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_tenant_entitlement_evaluation_snapshots_trigger_check
    CHECK (trigger IN ('assignment_changed', 'override_changed')),
  CONSTRAINT awcms_mini_tenant_entitlement_evaluation_snapshots_payload_size_check
    CHECK (length(features::text) + length(modules::text) + length(quotas::text) <= 200000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_evaluation_snapshots_tenant_idx
  ON awcms_mini_tenant_entitlement_evaluation_snapshots (tenant_id, resolved_at DESC);

ALTER TABLE awcms_mini_tenant_entitlement_evaluation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_entitlement_evaluation_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_entitlement_evaluation_snapshots_tenant_isolation
  ON awcms_mini_tenant_entitlement_evaluation_snapshots
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- Immutability / write-once triggers (defence in depth beneath the app guard)
-- =====================================================================

-- Assignment: identity/offer columns are frozen once created; `status` moves
-- forward only (a canceled assignment is terminal); supersede/cancel
-- provenance is write-once. Legal `status` pairs: active<->suspended,
-- active/suspended->canceled, and same-status no-ops. A backward move
-- (canceled->anything, suspended->... only to active/canceled) is rejected.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_entitlement_guard_assignment_immutability()
RETURNS trigger AS $$
BEGIN
  -- A canceled assignment is terminal: no field may change (belt-and-suspenders
  -- with the transition whitelist below, which already forbids leaving
  -- 'canceled').
  IF OLD.status = 'canceled' THEN
    RAISE EXCEPTION 'tenant_entitlement: assignment % is canceled and immutable (entitlement loss is a terminal state, never re-opened or edited)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Identity + offer snapshot are immutable — an upgrade/downgrade is a NEW
  -- assignment that supersedes this one, never an in-place offer swap.
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

  -- Forward-legal status transitions only.
  IF NOT (
       (OLD.status = 'active'    AND NEW.status IN ('active', 'suspended', 'canceled'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('suspended', 'active', 'canceled'))
  ) THEN
    RAISE EXCEPTION 'tenant_entitlement: illegal assignment status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Supersede is write-once (NULL -> non-null): a superseded row never returns
  -- to current.
  IF OLD.superseded_at IS NOT NULL
     AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
          OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION 'tenant_entitlement: assignment % supersede provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_entitlement_assignments_immutability
  BEFORE UPDATE ON awcms_mini_tenant_entitlement_assignments
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_entitlement_guard_assignment_immutability();

-- Assignment: forbid hard delete (entitlement loss is a status change, never a
-- DELETE — ADR-0022 §6/§9). DELETE is also REVOKEd from the app role below;
-- this trigger closes the same hole for any other writer.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_entitlement_guard_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tenant_entitlement: % rows are never hard-deleted (entitlement loss is a status transition; snapshots are append-only)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_entitlement_assignments_no_delete
  BEFORE DELETE ON awcms_mini_tenant_entitlement_assignments
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_entitlement_guard_no_delete();

-- Override: identity/effect columns frozen once created; ONLY the revocation
-- provenance may be written, and only once (NULL -> non-null).
CREATE OR REPLACE FUNCTION awcms_mini_tenant_entitlement_guard_override_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.target_kind IS DISTINCT FROM OLD.target_kind
     OR NEW.target_key IS DISTINCT FROM OLD.target_key
     OR NEW.effect IS DISTINCT FROM OLD.effect
     OR NEW.quota_is_unlimited IS DISTINCT FROM OLD.quota_is_unlimited
     OR NEW.quota_limit_value IS DISTINCT FROM OLD.quota_limit_value
     OR NEW.quota_unit IS DISTINCT FROM OLD.quota_unit
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'tenant_entitlement: override % content is immutable — only revocation is allowed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Revocation is write-once: NULL -> non-null only; a revoked override never
  -- returns to active (which the resolver treats as "applies").
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'tenant_entitlement: override % revocation is write-once (a revoked override cannot be reactivated or re-dated)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_entitlement_overrides_immutability
  BEFORE UPDATE ON awcms_mini_tenant_entitlement_overrides
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_entitlement_guard_override_immutability();

CREATE TRIGGER awcms_mini_tenant_entitlement_overrides_no_delete
  BEFORE DELETE ON awcms_mini_tenant_entitlement_overrides
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_entitlement_guard_no_delete();

-- Evaluation snapshot: fully append-only — an UPDATE or DELETE of a resolved
-- snapshot is rejected (the immutable history/reproducibility guarantee).
CREATE OR REPLACE FUNCTION awcms_mini_tenant_entitlement_guard_snapshot_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tenant_entitlement: evaluation snapshots are append-only (no UPDATE/DELETE)'
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_entitlement_evaluation_snapshots_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_tenant_entitlement_evaluation_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_entitlement_guard_snapshot_append_only();

-- =====================================================================
-- Least-privilege grants for the runtime app role (ADR-0022 §12)
-- =====================================================================
--
-- `awcms_mini_app` auto-inherits SELECT/INSERT/UPDATE/DELETE on every new
-- table (migration 013's `ALTER DEFAULT PRIVILEGES`). We narrow to the real
-- access each table needs:
--   - assignments / overrides : never hard-deleted (status transitions only) —
--     REVOKE DELETE.
--   - evaluation_snapshots     : append-only — REVOKE UPDATE + DELETE.
REVOKE DELETE ON awcms_mini_tenant_entitlement_assignments FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_tenant_entitlement_overrides FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_tenant_entitlement_evaluation_snapshots FROM awcms_mini_app;
