-- Issue #872 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `tenant_provisioning` module schema: the THIRD control-plane module. It
-- orchestrates an IDEMPOTENT, RESUMABLE tenant-provisioning run (tenant
-- bootstrap, owner identity, default configuration, entitlement assignment,
-- module preset, optional subdomain/domain, derived-application steps) with
-- durable checkpoints, bounded retries, lease/lock ownership, explicit
-- compensation classification, and non-destructive reconciliation. It PROVIDES
-- the `provisioning_status` capability (read-only, tenant-facing) and consumes
-- the fail-closed `effective_entitlement` contract (#871).
--
-- ## Placement (ADR-0022 §3) — a tenant-SCOPED control-plane module
--
-- The provisioning run and every child record is TENANT-SCOPED to the tenant
-- being provisioned: `tenant_id` + `ENABLE` + `FORCE ROW LEVEL SECURITY` + a
-- policy whose predicate is ALWAYS AND ONLY
-- `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022 §6
-- High-1 "no soft super-tenant": NEVER extended with an `OR platform-claim`
-- clause — a functional BYPASSRLS that slips past
-- `scripts/security-readiness.ts`'s role-attribute check). A platform operator
-- provisions/manages a tenant ONLY inside that target tenant's per-tenant
-- context (`SET LOCAL app.current_tenant_id`, one tenant per context, each
-- command audited) — exactly the §6(a) pattern. `tenant_id` is first in every
-- composite index (doc 04 §Index standard).
--
-- The `awcms_mini_tenants` REGISTRY row itself is owned by Core `tenant_admin`
-- (ADR-0022 §3) — provisioning references it by FK and CREATES it at request
-- time through the shared composition-root helper (never a duplicate tenant
-- registry). The GLOBAL `awcms_mini_tenants.tenant_code` unique index is the
-- ACID anti-duplicate-tenant anchor: two concurrent provisioning requests for
-- the same target tenant code cannot both create a tenant (one wins the INSERT,
-- the loser gets 0 rows -> a clean, deterministic 409, never a duplicate).
--
-- ## Data ownership (ADR-0022 §3, no-shared-table-write ADR-0013 §6)
--
-- `tenant_provisioning` owns these six tables; no other module writes them
-- (gated by `tests/unit/module-boundary.test.ts`). A tenant-plane module NEVER
-- queries them directly — downstream reads happen ONLY through the read-only
-- `provisioning_status` capability port.
--
-- ## Immutability / write-once (ADR-0022 §9, epic pattern #4)
--
-- Provisioning history is AUDITABLE and never silently rewritten:
--   - requests: identity/plan/inputs columns frozen once created; `status`
--     transitions are forward-legal only; provenance (started/completed/failed/
--     canceled) is write-once; NEVER hard-deleted.
--   - steps: identity/kind/compensation-class frozen; the durable `checkpoint`
--     is WRITE-ONCE (NULL -> non-null); `status` transitions are legal-only;
--     NEVER hard-deleted.
--   - step attempts / results / reconciliations: fully APPEND-ONLY (no UPDATE/
--     DELETE) — the immutable evidence trail.
--   - compensations: identity/class frozen; `status` one-way to a terminal.
-- Enforced by BEFORE triggers (defence in depth beneath the application guards)
-- AND least-privilege grant REVOKEs. A failed/canceled run runs recorded
-- COMPENSATION (classified reversible/manual/forbidden), it NEVER DELETEs
-- tenant data (ADR-0022 §6/§9). No secret/provider credential is ever stored
-- here — step inputs/outputs are minimized + redacted (ADR-0022 §3/§6/§8).

-- =====================================================================
-- 1. `awcms_mini_tenant_provisioning_requests` — one provisioning run per
--    tenant. State machine (ADR-0022 §11.1): requested -> in_progress ->
--    provisioned; in_progress -> compensating -> failed; failed/blocked ->
--    in_progress (idempotent retry); provisioned -> reconciling -> provisioned.
--    `inputs_hash` binds the immutable provisioning inputs to the target
--    identity (tenant_code) for idempotent replay; `idempotency_key` records
--    the Idempotency-Key used at creation. `readiness_state` is the mandatory
--    security-control gate: a run that cannot prove mandatory controls leaves
--    the tenant INACTIVE with `readiness_state = 'blocked'` and a visible
--    `blocked` request status (ADR-0022 §6/§9, AC "no active tenant without
--    mandatory controls without a visible blocked status").
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_provisioning_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  plan_key text NOT NULL,
  plan_version integer NOT NULL,
  target_key text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  readiness_state text NOT NULL DEFAULT 'pending',
  inputs_hash text NOT NULL,
  -- Minimized, redacted run inputs (tenant code/name + non-secret options like
  -- locale/subdomain/preset/offer) so start/resume/reconcile — separate HTTP
  -- calls that never carry the original body — can reconstruct the step inputs.
  -- NEVER a secret/password/token (the owner password is consumed once at
  -- request time and never stored; only its fingerprint feeds inputs_hash).
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  correlation_id text,
  total_steps integer NOT NULL DEFAULT 0,
  completed_steps integer NOT NULL DEFAULT 0,
  current_step_key text,
  last_error_class text,
  blocked_reason text,
  -- Lease/lock ownership (ADR-0022 §9, epic pattern #3): a start/resume claims
  -- an exclusive, time-bounded lease. A concurrent worker/operator either
  -- blocks on the row lock or finds the lease live -> a deterministic 409. An
  -- EXPIRED lease is reclaimable (worker-restart safe).
  lease_owner text,
  lease_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid,
  started_at timestamptz,
  provisioned_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid,
  cancel_reason text,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_tenant_provisioning_requests_status_check
    CHECK (status IN ('requested', 'in_progress', 'provisioned',
      'compensating', 'failed', 'blocked', 'canceled', 'reconciling')),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_readiness_check
    CHECK (readiness_state IN ('pending', 'ready', 'blocked')),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_plan_key_format_check
    CHECK (plan_key ~ '^[a-z][a-z0-9_]*$' AND length(plan_key) <= 100),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_plan_version_check
    CHECK (plan_version >= 1),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_target_key_format_check
    CHECK (target_key ~ '^[a-z0-9][a-z0-9_-]*$' AND length(target_key) <= 100),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_steps_count_check
    CHECK (completed_steps >= 0 AND completed_steps <= total_steps),
  -- A provisioned run must be marked ready; a blocked/failed run must never be
  -- silently "ready" (AC: no active tenant without controls without a visible
  -- blocked status).
  CONSTRAINT awcms_mini_tenant_provisioning_requests_provisioned_ready_check
    CHECK (status <> 'provisioned' OR readiness_state = 'ready'),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_cancel_consistency_check
    CHECK ((status = 'canceled') = (canceled_at IS NOT NULL)),
  CONSTRAINT awcms_mini_tenant_provisioning_requests_inputs_size_check
    CHECK (length(inputs::text) <= 20000)
);

-- One provisioning run per tenant (the run CREATES the tenant, and
-- `awcms_mini_tenants.id` is unique) — a superseding re-provision is out of
-- scope; drift is handled by reconciliation, not a second run.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_requests_tenant_key
  ON awcms_mini_tenant_provisioning_requests (tenant_id);

-- Idempotent replay anchor: at most one request per (tenant, idempotency_key).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_requests_idem_key
  ON awcms_mini_tenant_provisioning_requests (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_requests_tenant_status_idx
  ON awcms_mini_tenant_provisioning_requests (tenant_id, status);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_requests_target_idx
  ON awcms_mini_tenant_provisioning_requests (tenant_id, target_key);

ALTER TABLE awcms_mini_tenant_provisioning_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_provisioning_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_provisioning_requests_tenant_isolation
  ON awcms_mini_tenant_provisioning_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 2. `awcms_mini_tenant_provisioning_steps` — the materialized, ordered steps
--    of a run's versioned plan. Each step is a durable, resumable unit: a
--    completed step's `checkpoint` is WRITE-ONCE so a resume never re-runs it.
--    `step_kind` distinguishes `core` (pure DB, in-transaction) from `provider`
--    (external/async, dispatched OUTSIDE the source transaction via outbox) and
--    `derived` (contributed by a derived application). `compensation_class`
--    (reversible/manual/forbidden) is fixed by the plan and drives cancellation
--    /compensation safety (ADR-0022 §9). `max_attempts` bounds retries.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_provisioning_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  request_id uuid NOT NULL
    REFERENCES awcms_mini_tenant_provisioning_requests (id),
  step_key text NOT NULL,
  step_index integer NOT NULL,
  step_kind text NOT NULL,
  compensation_class text NOT NULL,
  optional boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  checkpoint jsonb,
  last_error_class text,
  last_error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  waiting_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_step_key_format_check
    CHECK (step_key ~ '^[a-z][a-z0-9_]*$' AND length(step_key) <= 100),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_index_check
    CHECK (step_index >= 0),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_kind_check
    CHECK (step_kind IN ('core', 'provider', 'derived')),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_comp_class_check
    CHECK (compensation_class IN ('reversible', 'manual', 'forbidden')),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'waiting',
      'skipped', 'compensation_pending', 'compensated', 'compensation_failed',
      'compensation_manual')),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts + 1),
  -- A completed step MUST carry its durable checkpoint (resumability).
  CONSTRAINT awcms_mini_tenant_provisioning_steps_completed_checkpoint_check
    CHECK (status <> 'completed' OR checkpoint IS NOT NULL),
  CONSTRAINT awcms_mini_tenant_provisioning_steps_error_message_size_check
    CHECK (last_error_message IS NULL OR length(last_error_message) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_steps_request_key_key
  ON awcms_mini_tenant_provisioning_steps (request_id, step_key);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_steps_request_index_key
  ON awcms_mini_tenant_provisioning_steps (request_id, step_index);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_steps_tenant_request_idx
  ON awcms_mini_tenant_provisioning_steps (tenant_id, request_id, step_index);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_steps_tenant_status_idx
  ON awcms_mini_tenant_provisioning_steps (tenant_id, status);

ALTER TABLE awcms_mini_tenant_provisioning_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_provisioning_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_provisioning_steps_tenant_isolation
  ON awcms_mini_tenant_provisioning_steps
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 3. `awcms_mini_tenant_provisioning_step_attempts` — APPEND-ONLY log of every
--    execution attempt of a step (idempotency/resume evidence + bounded-retry
--    audit). Each attempt carries its classified `error_class` (see
--    `domain/error-classification.ts`) and a SAFE, redacted message — never a
--    provider secret/token (ADR-0022 §6/§8).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_provisioning_step_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  request_id uuid NOT NULL
    REFERENCES awcms_mini_tenant_provisioning_requests (id),
  step_id uuid NOT NULL REFERENCES awcms_mini_tenant_provisioning_steps (id),
  step_key text NOT NULL,
  attempt_number integer NOT NULL,
  outcome text NOT NULL,
  error_class text,
  error_message text,
  correlation_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_tenant_provisioning_step_attempts_number_check
    CHECK (attempt_number >= 1),
  CONSTRAINT awcms_mini_tenant_provisioning_step_attempts_outcome_check
    CHECK (outcome IN ('succeeded', 'failed', 'waiting', 'skipped')),
  CONSTRAINT awcms_mini_tenant_provisioning_step_attempts_error_class_check
    CHECK (error_class IS NULL OR error_class IN ('transient', 'permanent',
      'provider_unavailable', 'validation', 'conflict', 'dependency_missing',
      'timeout')),
  CONSTRAINT awcms_mini_tenant_provisioning_step_attempts_message_size_check
    CHECK (error_message IS NULL OR length(error_message) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_step_attempts_step_num_key
  ON awcms_mini_tenant_provisioning_step_attempts (step_id, attempt_number);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_step_attempts_tenant_step_idx
  ON awcms_mini_tenant_provisioning_step_attempts (tenant_id, step_id, attempt_number);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_step_attempts_tenant_request_idx
  ON awcms_mini_tenant_provisioning_step_attempts (tenant_id, request_id, created_at DESC);

ALTER TABLE awcms_mini_tenant_provisioning_step_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_provisioning_step_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_provisioning_step_attempts_tenant_isolation
  ON awcms_mini_tenant_provisioning_step_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 4. `awcms_mini_tenant_provisioning_results` — APPEND-ONLY record of what each
--    completed step PRODUCED: a reference (resource_type + resource_id) to the
--    created resource (tenant, owner, entitlement assignment, module preset,
--    domain request, ...) plus a MINIMIZED, redacted output. Backs
--    reconciliation (desired-vs-actual) and compensation targeting — never a
--    password/token/secret (ADR-0022 §6/§8).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_provisioning_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  request_id uuid NOT NULL
    REFERENCES awcms_mini_tenant_provisioning_requests (id),
  step_id uuid NOT NULL REFERENCES awcms_mini_tenant_provisioning_steps (id),
  step_key text NOT NULL,
  result_kind text NOT NULL,
  resource_type text,
  resource_id text,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_tenant_provisioning_results_result_kind_format_check
    CHECK (result_kind ~ '^[a-z][a-z0-9_]*$' AND length(result_kind) <= 100),
  CONSTRAINT awcms_mini_tenant_provisioning_results_output_size_check
    CHECK (length(output::text) <= 20000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_results_step_key
  ON awcms_mini_tenant_provisioning_results (step_id);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_results_tenant_request_idx
  ON awcms_mini_tenant_provisioning_results (tenant_id, request_id);

ALTER TABLE awcms_mini_tenant_provisioning_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_provisioning_results FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_provisioning_results_tenant_isolation
  ON awcms_mini_tenant_provisioning_results
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 5. `awcms_mini_tenant_provisioning_compensations` — the recorded undo-saga
--    entries for a failed/canceled run. Each carries its explicit
--    `compensation_class` (reversible/manual/forbidden) and a one-way status.
--    A `forbidden` compensation (e.g. the tenant is already active) is recorded
--    as `skipped_forbidden` and NEVER deletes tenant data (ADR-0022 §6/§9). A
--    `manual` compensation surfaces `manual_required` for an operator.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_provisioning_compensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  request_id uuid NOT NULL
    REFERENCES awcms_mini_tenant_provisioning_requests (id),
  step_id uuid NOT NULL REFERENCES awcms_mini_tenant_provisioning_steps (id),
  step_key text NOT NULL,
  compensation_class text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  action text NOT NULL,
  note text,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_tenant_provisioning_compensations_class_check
    CHECK (compensation_class IN ('reversible', 'manual', 'forbidden')),
  CONSTRAINT awcms_mini_tenant_provisioning_compensations_status_check
    CHECK (status IN ('pending', 'completed', 'manual_required', 'failed',
      'skipped_forbidden')),
  CONSTRAINT awcms_mini_tenant_provisioning_compensations_action_format_check
    CHECK (action ~ '^[a-z][a-z0-9_]*$' AND length(action) <= 100),
  CONSTRAINT awcms_mini_tenant_provisioning_compensations_note_size_check
    CHECK (note IS NULL OR length(note) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_compensations_step_key
  ON awcms_mini_tenant_provisioning_compensations (step_id);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_compensations_tenant_request_idx
  ON awcms_mini_tenant_provisioning_compensations (tenant_id, request_id);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_compensations_tenant_status_idx
  ON awcms_mini_tenant_provisioning_compensations (tenant_id, status);

ALTER TABLE awcms_mini_tenant_provisioning_compensations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_provisioning_compensations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_provisioning_compensations_tenant_isolation
  ON awcms_mini_tenant_provisioning_compensations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 6. `awcms_mini_tenant_provisioning_reconciliations` — APPEND-ONLY reconcile
--    reports comparing DESIRED (plan/results) vs ACTUAL state. Reconciliation
--    IDENTIFIES drift and OFFERS safe operator actions — it NEVER performs a
--    destructive auto-fix by default (ADR-0022 §9, AC). `drift` is a bounded
--    JSON list of { stepKey, expected, actual, safeActions }.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_provisioning_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  request_id uuid NOT NULL
    REFERENCES awcms_mini_tenant_provisioning_requests (id),
  status text NOT NULL,
  drift_count integer NOT NULL DEFAULT 0,
  drift jsonb NOT NULL DEFAULT '[]'::jsonb,
  correlation_id text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  checked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_tenant_provisioning_reconciliations_status_check
    CHECK (status IN ('consistent', 'drift_detected', 'error')),
  CONSTRAINT awcms_mini_tenant_provisioning_reconciliations_drift_count_check
    CHECK (drift_count >= 0),
  CONSTRAINT awcms_mini_tenant_provisioning_reconciliations_drift_size_check
    CHECK (length(drift::text) <= 50000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_provisioning_reconciliations_tenant_request_idx
  ON awcms_mini_tenant_provisioning_reconciliations (tenant_id, request_id, checked_at DESC);

ALTER TABLE awcms_mini_tenant_provisioning_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_provisioning_reconciliations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_provisioning_reconciliations_tenant_isolation
  ON awcms_mini_tenant_provisioning_reconciliations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- Immutability / write-once / append-only triggers
-- (defence in depth beneath the application-layer guards)
-- =====================================================================

-- Shared: forbid any hard DELETE (provisioning history is never destroyed;
-- entitlement/tenant data loss is never a compensation — ADR-0022 §6/§9).
CREATE OR REPLACE FUNCTION awcms_mini_tenant_provisioning_guard_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tenant_provisioning: % rows are never hard-deleted (provisioning history is immutable evidence)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Shared: fully append-only (reject UPDATE and DELETE).
CREATE OR REPLACE FUNCTION awcms_mini_tenant_provisioning_guard_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tenant_provisioning: % is append-only (no UPDATE/DELETE)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Request: identity/plan/inputs frozen; forward-legal status transitions only;
-- provenance write-once; readiness never silently downgraded from a terminal.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_provisioning_guard_request_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.plan_key IS DISTINCT FROM OLD.plan_key
     OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
     OR NEW.target_key IS DISTINCT FROM OLD.target_key
     OR NEW.inputs_hash IS DISTINCT FROM OLD.inputs_hash
     OR NEW.inputs::text IS DISTINCT FROM OLD.inputs::text
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_provisioning: request % identity/plan/inputs columns are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A canceled run is terminal.
  IF OLD.status = 'canceled' AND NEW.status <> 'canceled' THEN
    RAISE EXCEPTION 'tenant_provisioning: request % is canceled and terminal', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Forward-legal status transitions (ADR-0022 §11.1). Same-status no-ops are
  -- allowed (resume/step advance rewrites counters without a status change).
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested'    AND NEW.status IN ('in_progress', 'canceled'))
    OR (OLD.status = 'in_progress'  AND NEW.status IN ('provisioned', 'compensating', 'blocked', 'canceled'))
    OR (OLD.status = 'compensating' AND NEW.status IN ('failed', 'blocked'))
    OR (OLD.status = 'failed'       AND NEW.status IN ('in_progress', 'canceled'))
    OR (OLD.status = 'blocked'      AND NEW.status IN ('in_progress', 'compensating', 'canceled'))
    OR (OLD.status = 'provisioned'  AND NEW.status = 'reconciling')
    OR (OLD.status = 'reconciling'  AND NEW.status = 'provisioned')
  ) THEN
    RAISE EXCEPTION 'tenant_provisioning: illegal request status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Provenance write-once (a set timestamp never moves).
  IF OLD.provisioned_at IS NOT NULL AND NEW.provisioned_at IS DISTINCT FROM OLD.provisioned_at THEN
    RAISE EXCEPTION 'tenant_provisioning: request % provisioned_at is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.canceled_at IS NOT NULL AND NEW.canceled_at IS DISTINCT FROM OLD.canceled_at THEN
    RAISE EXCEPTION 'tenant_provisioning: request % canceled_at is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_provisioning_requests_immutability
  BEFORE UPDATE ON awcms_mini_tenant_provisioning_requests
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_request_immutability();

CREATE TRIGGER awcms_mini_tenant_provisioning_requests_no_delete
  BEFORE DELETE ON awcms_mini_tenant_provisioning_requests
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_no_delete();

-- Step: identity/kind/comp-class frozen; checkpoint WRITE-ONCE (NULL ->
-- non-null); legal status transitions only.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_provisioning_guard_step_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.step_key IS DISTINCT FROM OLD.step_key
     OR NEW.step_index IS DISTINCT FROM OLD.step_index
     OR NEW.step_kind IS DISTINCT FROM OLD.step_kind
     OR NEW.compensation_class IS DISTINCT FROM OLD.compensation_class
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.optional IS DISTINCT FROM OLD.optional
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_provisioning: step % identity/kind columns are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Checkpoint is write-once: once a step records its durable checkpoint it is
  -- never rewritten (a resume trusts it and never re-runs the step).
  IF OLD.checkpoint IS NOT NULL AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint THEN
    RAISE EXCEPTION 'tenant_provisioning: step % checkpoint is write-once (immutable once set)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legal step status transitions. `completed`/`skipped`/`compensated` are
  -- terminal-forward; a completed step never reopens.
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('running', 'skipped'))
    OR (OLD.status = 'running'  AND NEW.status IN ('completed', 'failed', 'waiting', 'skipped'))
    OR (OLD.status = 'waiting'  AND NEW.status IN ('completed', 'failed', 'running'))
    OR (OLD.status = 'failed'   AND NEW.status IN ('running', 'compensation_pending'))
    OR (OLD.status = 'completed' AND NEW.status = 'compensation_pending')
    OR (OLD.status = 'compensation_pending' AND NEW.status IN ('compensated', 'compensation_failed', 'compensation_manual'))
    OR (OLD.status = 'compensation_failed' AND NEW.status IN ('compensation_pending', 'compensated', 'compensation_manual'))
  ) THEN
    RAISE EXCEPTION 'tenant_provisioning: illegal step status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_provisioning_steps_immutability
  BEFORE UPDATE ON awcms_mini_tenant_provisioning_steps
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_step_immutability();

CREATE TRIGGER awcms_mini_tenant_provisioning_steps_no_delete
  BEFORE DELETE ON awcms_mini_tenant_provisioning_steps
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_no_delete();

-- Compensation: identity/class frozen; status one-way to a terminal.
CREATE OR REPLACE FUNCTION awcms_mini_tenant_provisioning_guard_compensation_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.step_id IS DISTINCT FROM OLD.step_id
     OR NEW.step_key IS DISTINCT FROM OLD.step_key
     OR NEW.compensation_class IS DISTINCT FROM OLD.compensation_class
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_provisioning: compensation % identity/class columns are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A resolved (terminal) compensation is write-once.
  IF OLD.status IN ('completed', 'skipped_forbidden')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'tenant_provisioning: compensation % is terminal (% ) and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_tenant_provisioning_compensations_immutability
  BEFORE UPDATE ON awcms_mini_tenant_provisioning_compensations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_compensation_immutability();

CREATE TRIGGER awcms_mini_tenant_provisioning_compensations_no_delete
  BEFORE DELETE ON awcms_mini_tenant_provisioning_compensations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_no_delete();

-- Append-only tables: step attempts, results, reconciliations.
CREATE TRIGGER awcms_mini_tenant_provisioning_step_attempts_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_tenant_provisioning_step_attempts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_append_only();

CREATE TRIGGER awcms_mini_tenant_provisioning_results_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_tenant_provisioning_results
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_append_only();

CREATE TRIGGER awcms_mini_tenant_provisioning_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_tenant_provisioning_reconciliations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_tenant_provisioning_guard_append_only();

-- =====================================================================
-- Least-privilege grants for the runtime app role (ADR-0022 §12)
-- =====================================================================
--
-- `awcms_mini_app` auto-inherits SELECT/INSERT/UPDATE/DELETE on every new table
-- (migration 013's `ALTER DEFAULT PRIVILEGES`). Narrow to real access:
--   - requests / steps / compensations : never hard-deleted (status
--     transitions only) — REVOKE DELETE.
--   - step_attempts / results / reconciliations : append-only — REVOKE UPDATE +
--     DELETE.
REVOKE DELETE ON awcms_mini_tenant_provisioning_requests FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_tenant_provisioning_steps FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_tenant_provisioning_compensations FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_tenant_provisioning_step_attempts FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_tenant_provisioning_results FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_tenant_provisioning_reconciliations FROM awcms_mini_app;
