-- Issue #873 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `tenant_lifecycle` module schema: the FOURTH control-plane module. It records
-- the precise SaaS lifecycle STATE of a tenant (provisioning/trial/active/
-- renewal_due/past_due/grace/suspended/canceled/restoring/blocked), validates
-- forward-legal transitions, keeps an append-only transition history, schedules
-- future transitions (trial/grace expiry) that a worker applies idempotently,
-- and derives — never stores as truth — the effective ACCESS RESTRICTIONS a
-- state implies. A downgrade/suspend/cancel changes STATE + effective
-- entitlement + access, but NEVER deletes tenant data (ADR-0022 §6/§9, AC).
--
-- ## Placement (ADR-0022 §3) — a tenant-SCOPED control-plane module
--
-- Every row is TENANT-SCOPED: `tenant_id` + `ENABLE` + `FORCE ROW LEVEL
-- SECURITY` + a policy whose predicate is ALWAYS AND ONLY
-- `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022 §6
-- High-1 "no soft super-tenant": NEVER extended with an `OR platform-claim`
-- clause — a functional BYPASSRLS that slips past
-- `scripts/security-readiness.ts`'s role-attribute check). A platform operator
-- transitions a tenant's lifecycle ONLY inside that target tenant's per-tenant
-- context (`SET LOCAL app.current_tenant_id`, one tenant per context, each
-- command audited) — exactly the §6(a) pattern. `tenant_id` is first in every
-- composite index (doc 04 §Index standard).
--
-- The `awcms_mini_tenants` REGISTRY row is owned by Core `tenant_admin`; this
-- module references it by FK and NEVER duplicates it. Lifecycle is a DISTINCT
-- axis from entitlement (#871) and permission (identity_access): it decides
-- WHETHER a tenant may operate (and how much), not WHICH plan features it has.
--
-- ## Immutability / write-once (ADR-0022 §9, epic pattern #4)
--
-- `tenant_lifecycle` owns these two tables; no other module writes them (gated
-- by `tests/unit/module-boundary.test.ts`).
--   - states: one CURRENT lifecycle record per tenant. Identity/tenant frozen;
--     `state` transitions are forward-legal ONLY (whitelist trigger mirroring
--     `domain/lifecycle-state.ts`); `version` is a monotonic optimistic-
--     concurrency counter that MUST increase by exactly one on every state
--     change; the row is NEVER hard-deleted (a suspend/cancel/downgrade is a
--     state change, never a delete — ADR-0022 §6/§9). REVOKE DELETE.
--   - history: fully APPEND-ONLY (reject UPDATE/DELETE) — the immutable
--     provenance trail (from/to state, effective_at, actor, source, reason)
--     that a same-commit transition writes. REVOKE UPDATE + DELETE.
-- No secret is ever stored here — reasons/notes are operator free text bounded
-- and non-sensitive (ADR-0022 §8).

-- =====================================================================
-- 1. `awcms_mini_tenant_lifecycle_states` — the single CURRENT lifecycle record
--    per tenant. `version` is the optimistic-concurrency token: every write
--    path row-locks this row (`SELECT ... FOR UPDATE`) then issues a
--    state+version-predicated UPDATE, so a concurrent/invalid transition is a
--    deterministic 409 (AC). The `scheduled_*` columns hold at most one pending
--    future transition (trial/grace expiry) that the idempotent scheduler
--    applies; they are cleared on apply/cancel.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_lifecycle_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  state text NOT NULL DEFAULT 'provisioning',
  previous_state text,
  -- Optimistic-concurrency counter: +1 on every state change (trigger-enforced).
  version integer NOT NULL DEFAULT 1,
  -- Provenance of the CURRENT state (the append-only trail lives in history).
  reason text,
  source text NOT NULL DEFAULT 'system',
  actor uuid,
  effective_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz NOT NULL DEFAULT now(),
  -- Informational trial/grace anchors (the scheduler reads scheduled_* below,
  -- these are for display/reporting only).
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  -- At most one pending scheduled transition (trial->active/grace, grace->
  -- suspended, ...). Applied idempotently by the scheduler; cleared on apply.
  scheduled_to_state text,
  scheduled_at timestamptz,
  scheduled_reason text,
  scheduled_source text,
  scheduled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_tenant_lifecycle_states_state_check
    CHECK (state IN ('provisioning', 'trial', 'active', 'renewal_due',
      'past_due', 'grace', 'suspended', 'canceled', 'restoring', 'blocked')),
  CONSTRAINT awcms_mini_tenant_lifecycle_states_previous_state_check
    CHECK (previous_state IS NULL OR previous_state IN ('provisioning', 'trial',
      'active', 'renewal_due', 'past_due', 'grace', 'suspended', 'canceled',
      'restoring', 'blocked')),
  CONSTRAINT awcms_mini_tenant_lifecycle_states_scheduled_state_check
    CHECK (scheduled_to_state IS NULL OR scheduled_to_state IN ('provisioning',
      'trial', 'active', 'renewal_due', 'past_due', 'grace', 'suspended',
      'canceled', 'restoring', 'blocked')),
  -- A schedule is all-or-nothing: a target state and its due time are set
  -- together (fail-closed against a half-set schedule that never fires or
  -- fires immediately).
  CONSTRAINT awcms_mini_tenant_lifecycle_states_schedule_pair_check
    CHECK ((scheduled_to_state IS NULL) = (scheduled_at IS NULL)),
  CONSTRAINT awcms_mini_tenant_lifecycle_states_source_check
    CHECK (source IN ('system', 'operator', 'scheduler', 'billing',
      'provisioning', 'restore')),
  CONSTRAINT awcms_mini_tenant_lifecycle_states_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_tenant_lifecycle_states_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000),
  CONSTRAINT awcms_mini_tenant_lifecycle_states_scheduled_reason_size_check
    CHECK (scheduled_reason IS NULL OR length(scheduled_reason) <= 2000)
);

-- One lifecycle record per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_lifecycle_states_tenant_key
  ON awcms_mini_tenant_lifecycle_states (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_lifecycle_states_tenant_state_idx
  ON awcms_mini_tenant_lifecycle_states (tenant_id, state);

-- Drives the per-tenant scheduler lookup (a due, pending scheduled transition).
CREATE INDEX IF NOT EXISTS awcms_mini_tenant_lifecycle_states_scheduled_idx
  ON awcms_mini_tenant_lifecycle_states (tenant_id, scheduled_at)
  WHERE scheduled_to_state IS NOT NULL;

ALTER TABLE awcms_mini_tenant_lifecycle_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_lifecycle_states FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_lifecycle_states_tenant_isolation
  ON awcms_mini_tenant_lifecycle_states
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 2. `awcms_mini_tenant_lifecycle_history` — APPEND-ONLY provenance of every
--    lifecycle event (transition, downgrade, schedule set/cancel, restore).
--    Written in the SAME transaction as the state change it describes. Carries
--    only bounded, non-sensitive fields; `metadata` holds an explainable,
--    tenant-facing summary (e.g. a downgrade's before/after entitlement offer).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_lifecycle_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  -- The kind of lifecycle event, so the timeline / reporting projection can
  -- distinguish a state transition from a schedule change or a downgrade.
  event_kind text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  -- The version the state row REACHED with this event (a state change) or held
  -- (a schedule set/cancel) — ties history to the optimistic-concurrency token.
  version integer NOT NULL,
  reason text,
  source text NOT NULL,
  actor uuid,
  correlation_id text,
  scheduled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_tenant_lifecycle_history_event_kind_check
    CHECK (event_kind IN ('transition', 'downgrade', 'schedule_set',
      'schedule_canceled', 'restore', 'reconciled')),
  CONSTRAINT awcms_mini_tenant_lifecycle_history_from_state_check
    CHECK (from_state IS NULL OR from_state IN ('provisioning', 'trial',
      'active', 'renewal_due', 'past_due', 'grace', 'suspended', 'canceled',
      'restoring', 'blocked')),
  CONSTRAINT awcms_mini_tenant_lifecycle_history_to_state_check
    CHECK (to_state IN ('provisioning', 'trial', 'active', 'renewal_due',
      'past_due', 'grace', 'suspended', 'canceled', 'restoring', 'blocked')),
  CONSTRAINT awcms_mini_tenant_lifecycle_history_source_check
    CHECK (source IN ('system', 'operator', 'scheduler', 'billing',
      'provisioning', 'restore')),
  CONSTRAINT awcms_mini_tenant_lifecycle_history_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_tenant_lifecycle_history_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000),
  CONSTRAINT awcms_mini_tenant_lifecycle_history_metadata_size_check
    CHECK (length(metadata::text) <= 20000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_lifecycle_history_tenant_created_idx
  ON awcms_mini_tenant_lifecycle_history (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_lifecycle_history_tenant_kind_idx
  ON awcms_mini_tenant_lifecycle_history (tenant_id, event_kind, created_at DESC);

ALTER TABLE awcms_mini_tenant_lifecycle_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_lifecycle_history FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_lifecycle_history_tenant_isolation
  ON awcms_mini_tenant_lifecycle_history
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- Immutability / write-once / append-only triggers
-- (defence in depth beneath the application-layer guards)
-- =====================================================================

-- Shared: forbid any hard DELETE (a lifecycle record is never destroyed; a
-- suspend/cancel/downgrade is a state change, never a delete — ADR-0022 §6/§9).
CREATE OR REPLACE FUNCTION awcms_mini_tenant_lifecycle_guard_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tenant_lifecycle: % rows are never hard-deleted (lifecycle history is immutable; suspend/cancel/downgrade change state, never delete)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Shared: fully append-only (reject UPDATE and DELETE).
CREATE OR REPLACE FUNCTION awcms_mini_tenant_lifecycle_guard_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tenant_lifecycle: % is append-only (no UPDATE/DELETE)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- States: identity/tenant frozen; forward-legal status transitions ONLY
-- (whitelist mirrors domain/lifecycle-state.ts); version +1 on every state
-- change; previous_state must equal the OLD state on a transition.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_lifecycle_guard_state_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_lifecycle: state % tenant_id/created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> OLD.state THEN
    -- Forward-legal transition whitelist (ADR-0022 §11.2). `canceled` is
    -- protected: it may only leave toward `restoring` (a reconciled reactivate),
    -- never a direct jump back to active.
    IF NOT (
         (OLD.state = 'provisioning' AND NEW.state IN ('trial', 'active', 'blocked', 'canceled'))
      OR (OLD.state = 'trial'        AND NEW.state IN ('active', 'grace', 'past_due', 'suspended', 'canceled', 'blocked'))
      OR (OLD.state = 'active'       AND NEW.state IN ('renewal_due', 'past_due', 'grace', 'suspended', 'canceled', 'blocked'))
      OR (OLD.state = 'renewal_due'  AND NEW.state IN ('active', 'past_due', 'grace', 'suspended', 'canceled', 'blocked'))
      OR (OLD.state = 'past_due'     AND NEW.state IN ('active', 'grace', 'suspended', 'canceled', 'blocked'))
      OR (OLD.state = 'grace'        AND NEW.state IN ('active', 'past_due', 'suspended', 'canceled', 'blocked'))
      OR (OLD.state = 'suspended'    AND NEW.state IN ('restoring', 'canceled', 'blocked'))
      OR (OLD.state = 'canceled'     AND NEW.state IN ('restoring'))
      OR (OLD.state = 'restoring'    AND NEW.state IN ('active', 'suspended', 'canceled', 'blocked'))
      OR (OLD.state = 'blocked'      AND NEW.state IN ('active', 'suspended', 'canceled', 'restoring'))
    ) THEN
      RAISE EXCEPTION 'tenant_lifecycle: illegal state transition % -> %', OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;

    -- Optimistic-concurrency token advances by exactly one per state change.
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'tenant_lifecycle: state % version must advance by exactly one on a transition (% -> %)', OLD.id, OLD.version, NEW.version
        USING ERRCODE = 'check_violation';
    END IF;

    -- previous_state provenance must record where we came from.
    IF NEW.previous_state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'tenant_lifecycle: state % previous_state must equal the prior state on a transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- No state change: version must not move (a schedule set/clear or anchor
    -- update rewrites scheduling columns without a transition).
    IF NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'tenant_lifecycle: state % version may only change on a state transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_lifecycle_states_immutability
  BEFORE UPDATE ON awcms_mini_tenant_lifecycle_states
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_lifecycle_guard_state_immutability();

CREATE TRIGGER awcms_mini_tenant_lifecycle_states_no_delete
  BEFORE DELETE ON awcms_mini_tenant_lifecycle_states
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_lifecycle_guard_no_delete();

CREATE TRIGGER awcms_mini_tenant_lifecycle_history_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_tenant_lifecycle_history
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_lifecycle_guard_append_only();

-- =====================================================================
-- Least-privilege grants for the runtime app role (ADR-0022 §12)
-- =====================================================================
--
-- `awcms_mini_app` auto-inherits SELECT/INSERT/UPDATE/DELETE on every new table
-- (migration 013's `ALTER DEFAULT PRIVILEGES`). Narrow to real access:
--   - states  : never hard-deleted (state transitions only) — REVOKE DELETE.
--   - history : append-only — REVOKE UPDATE + DELETE.
REVOKE DELETE ON awcms_mini_tenant_lifecycle_states FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_tenant_lifecycle_history FROM awcms_mini_app;
