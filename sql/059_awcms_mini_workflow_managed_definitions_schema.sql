-- Issue #747 (epic `platform-evolution` #738, Wave 2) — evolve the
-- Issue 11.1 linear approval engine (migration 012) into a managed,
-- versioned, graph-based workflow engine: draft/publish/retire lifecycle
-- with immutable published/retired versions, generic nodes/transitions
-- (sequential, conditional, parallel/join, notify), quorum/any/all
-- approval rules, delegation/substitution, escalation/timeout policies,
-- administrative recovery (reassign/cancel/force-decision), and a
-- consolidated approval inbox.
--
-- This is an EVOLUTION of the existing 4 tables, not a new module — the
-- old linear `steps` (jsonb ordered step list) and `current_step_order`
-- concepts are replaced by a `graph` (nodes + transitions) and per-node
-- `awcms_mini_workflow_tasks` rows (one row per activated node instance;
-- `awcms_mini_workflow_task_assignments` tracks the set of eligible
-- deciders per task, needed for quorum/any/all and delegation). This base
-- has zero real callers of the old linear shape outside its own tests
-- (`src/modules/workflow-approval/README.md`: "no public create-
-- definition/start-instance endpoint"), so the old columns are replaced
-- in place rather than kept as a parallel legacy path — every caller
-- (routes, application code, tests) is updated in this same change.
--
-- Doc 21 §3 decision tree Q5 governs condition evaluation and module-
-- contributed actions: conditions are bounded comparisons over named
-- facts declared by the definition's `facts_schema` (never arbitrary
-- expressions/scripting/eval), and module-contributed resolvers/actions
-- are a static, reviewed-source-code registry
-- (`src/modules/workflow-approval/infrastructure/condition-action-
-- registry.ts`, mirroring `domain-event-runtime`'s `DOMAIN_EVENT_
-- CONSUMERS`), never a runtime-registration call.

-- =========================================================================
-- 1. awcms_mini_workflow_definitions — add version/lifecycle/graph columns
-- =========================================================================

ALTER TABLE awcms_mini_workflow_definitions
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS graph jsonb,
  ADD COLUMN IF NOT EXISTS facts_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_by_tenant_user_id uuid,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by_tenant_user_id uuid,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by_tenant_user_id uuid;

-- Backfill any pre-existing row (dev/test fixtures only — this base ships
-- no production data for this module, README's "no public create-
-- definition endpoint" precedent) so the NOT NULL below is satisfiable.
UPDATE awcms_mini_workflow_definitions
SET graph = jsonb_build_object(
      'startNodeId', 'legacy_end',
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'legacy_end', 'type', 'end', 'outcome', 'approved')
      )
    ),
    lifecycle_status = CASE WHEN status = 'active' THEN 'active' ELSE 'retired' END
WHERE graph IS NULL;

ALTER TABLE awcms_mini_workflow_definitions
  ALTER COLUMN graph SET NOT NULL;

ALTER TABLE awcms_mini_workflow_definitions
  DROP COLUMN IF EXISTS steps,
  DROP COLUMN IF EXISTS status;

ALTER TABLE awcms_mini_workflow_definitions
  ADD CONSTRAINT awcms_mini_workflow_definitions_lifecycle_status_check
    CHECK (lifecycle_status IN ('draft', 'active', 'retired')),
  ADD CONSTRAINT awcms_mini_workflow_definitions_version_check
    CHECK (version >= 1);

DROP INDEX IF EXISTS awcms_mini_workflow_definitions_key_dedup;

-- Version history: one row per (tenant, workflow_key, version).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_workflow_definitions_key_version_dedup
  ON awcms_mini_workflow_definitions (tenant_id, workflow_key, version)
  WHERE deleted_at IS NULL;

-- Immutability guardrail at the data layer: at most one `active` version
-- per (tenant, workflow_key) at a time — publishing a new version must
-- retire the previous active one first (enforced in application code,
-- `application/workflow-definition-directory.ts`'s `publishWorkflowDefinition`,
-- inside the SAME transaction; this index is the defense-in-depth backstop).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_workflow_definitions_key_active_dedup
  ON awcms_mini_workflow_definitions (tenant_id, workflow_key)
  WHERE deleted_at IS NULL AND lifecycle_status = 'active';

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_definitions_tenant_lifecycle_idx
  ON awcms_mini_workflow_definitions (tenant_id, lifecycle_status);

-- =========================================================================
-- 2. awcms_mini_workflow_instances — version pin, facts snapshot, cancel
-- =========================================================================

ALTER TABLE awcms_mini_workflow_instances
  ADD COLUMN IF NOT EXISTS workflow_definition_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_tenant_user_id uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

-- `current_step_order` (linear-only concept) is replaced by the set of
-- currently-`pending` `awcms_mini_workflow_tasks` rows for the instance —
-- the correct representation once parallel branches allow MULTIPLE nodes
-- to be concurrently active (a single integer "current step" cannot
-- express that).
ALTER TABLE awcms_mini_workflow_instances
  DROP COLUMN IF EXISTS current_step_order;

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_instances_tenant_due_idx
  ON awcms_mini_workflow_instances (tenant_id, status, due_at);

-- =========================================================================
-- 3. awcms_mini_workflow_tasks — node-based (not linear step-based)
-- =========================================================================

ALTER TABLE awcms_mini_workflow_tasks
  ADD COLUMN IF NOT EXISTS node_id text,
  ADD COLUMN IF NOT EXISTS parent_node_id text,
  ADD COLUMN IF NOT EXISTS quorum_rule text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS quorum_threshold integer,
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_step integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE awcms_mini_workflow_tasks
SET node_id = 'legacy_step_' || step_order::text
WHERE node_id IS NULL;

ALTER TABLE awcms_mini_workflow_tasks
  ALTER COLUMN node_id SET NOT NULL,
  DROP COLUMN IF EXISTS step_order;

ALTER TABLE awcms_mini_workflow_tasks
  DROP CONSTRAINT IF EXISTS awcms_mini_workflow_tasks_status_check;

ALTER TABLE awcms_mini_workflow_tasks
  ADD CONSTRAINT awcms_mini_workflow_tasks_status_check
    CHECK (status IN ('pending', 'completed', 'skipped', 'cancelled')),
  ADD CONSTRAINT awcms_mini_workflow_tasks_quorum_rule_check
    CHECK (quorum_rule IN ('all', 'any', 'quorum')),
  ADD CONSTRAINT awcms_mini_workflow_tasks_quorum_threshold_check
    CHECK (quorum_threshold IS NULL OR quorum_threshold >= 1),
  ADD CONSTRAINT awcms_mini_workflow_tasks_escalation_step_check
    CHECK (escalation_step >= 0);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_tasks_tenant_due_idx
  ON awcms_mini_workflow_tasks (tenant_id, status, due_at);

-- =========================================================================
-- 4. awcms_mini_workflow_task_assignments — eligible deciders per task
--    (needed for quorum/any/all, delegation, and reassignment history —
--    reassignment appends a new row and marks the old one 'reassigned',
--    it never overwrites/deletes, matching AGENTS.md rule #12 immutability
--    for decision-relevant history).
-- =========================================================================

CREATE TABLE IF NOT EXISTS awcms_mini_workflow_task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  workflow_task_id uuid NOT NULL REFERENCES awcms_mini_workflow_tasks (id),
  tenant_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  reassigned_to_tenant_user_id uuid,
  reassigned_at timestamptz,
  reassigned_by_tenant_user_id uuid,
  reassign_reason text,
  CONSTRAINT awcms_mini_workflow_task_assignments_status_check
    CHECK (status IN ('pending', 'decided', 'reassigned', 'skipped'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_task_assignments_tenant_idx
  ON awcms_mini_workflow_task_assignments (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_task_assignments_task_idx
  ON awcms_mini_workflow_task_assignments (workflow_task_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_task_assignments_user_idx
  ON awcms_mini_workflow_task_assignments (tenant_id, tenant_user_id, status);

ALTER TABLE awcms_mini_workflow_task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_workflow_task_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_task_assignments_tenant_isolation
  ON awcms_mini_workflow_task_assignments
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =========================================================================
-- 4b. awcms_mini_workflow_join_arrivals — fan-in tracking for `parallel`/
--     `join` nodes. Append-only, idempotent-by-construction (the unique
--     index below is the "a branch can only arrive once" guard): the
--     graph engine (`application/workflow-graph-engine.ts`) INSERTs
--     `... ON CONFLICT DO NOTHING` whenever a branch's traversal reaches
--     its declared join node, then counts DISTINCT `branch_node_id` rows
--     against the join node's `awaitNodeIds` to decide readiness.
-- =========================================================================

CREATE TABLE IF NOT EXISTS awcms_mini_workflow_join_arrivals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  workflow_instance_id uuid NOT NULL REFERENCES awcms_mini_workflow_instances (id),
  join_node_id text NOT NULL,
  branch_node_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_workflow_join_arrivals_identity_key
  ON awcms_mini_workflow_join_arrivals (workflow_instance_id, join_node_id, branch_node_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_join_arrivals_tenant_idx
  ON awcms_mini_workflow_join_arrivals (tenant_id);

ALTER TABLE awcms_mini_workflow_join_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_workflow_join_arrivals FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_join_arrivals_tenant_isolation
  ON awcms_mini_workflow_join_arrivals
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =========================================================================
-- 5. awcms_mini_workflow_decisions — extend for delegation + admin override
-- =========================================================================

ALTER TABLE awcms_mini_workflow_decisions
  ADD COLUMN IF NOT EXISTS on_behalf_of_tenant_user_id uuid,
  ADD COLUMN IF NOT EXISTS is_administrative_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason text;

ALTER TABLE awcms_mini_workflow_decisions
  DROP CONSTRAINT IF EXISTS awcms_mini_workflow_decisions_decision_check;

ALTER TABLE awcms_mini_workflow_decisions
  ADD CONSTRAINT awcms_mini_workflow_decisions_decision_check
    CHECK (decision IN ('approve', 'reject', 'force_approve', 'force_reject'));

-- =========================================================================
-- 6. awcms_mini_workflow_delegations — effective-dated substitute assignment
-- =========================================================================

CREATE TABLE IF NOT EXISTS awcms_mini_workflow_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  delegator_tenant_user_id uuid NOT NULL,
  delegate_tenant_user_id uuid NOT NULL,
  workflow_key text,
  resource_type text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_tenant_user_id uuid,
  revoke_reason text,
  CONSTRAINT awcms_mini_workflow_delegations_status_check
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT awcms_mini_workflow_delegations_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT awcms_mini_workflow_delegations_not_self_check
    CHECK (delegator_tenant_user_id <> delegate_tenant_user_id)
);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_delegations_tenant_idx
  ON awcms_mini_workflow_delegations (tenant_id);

-- Lookup direction used at decision time: "who may act for this delegator,
-- right now, for this workflow_key/resource_type" (domain/workflow-
-- delegation.ts's `resolveEffectiveDeciderIds`).
CREATE INDEX IF NOT EXISTS awcms_mini_workflow_delegations_delegator_idx
  ON awcms_mini_workflow_delegations
    (tenant_id, delegator_tenant_user_id, status, effective_from, effective_to);

ALTER TABLE awcms_mini_workflow_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_workflow_delegations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_delegations_tenant_isolation
  ON awcms_mini_workflow_delegations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =========================================================================
-- 7. Permission catalog additions (doc 17 §Registry module & activity)
-- =========================================================================

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('workflow', 'definition', 'read', 'Read workflow definitions and version history'),
  ('workflow', 'definition', 'create', 'Create a new draft workflow definition'),
  ('workflow', 'definition', 'update', 'Update an existing draft workflow definition'),
  ('workflow', 'definition', 'publish', 'Publish/activate a draft workflow definition version'),
  ('workflow', 'definition', 'retire', 'Retire an active workflow definition version'),
  ('workflow', 'definition', 'delete', 'Soft-delete a draft workflow definition'),
  ('workflow', 'recovery', 'reassign', 'Reassign a pending workflow task to another tenant user'),
  ('workflow', 'recovery', 'cancel', 'Cancel a running workflow instance'),
  ('workflow', 'recovery', 'force_decide', 'Force-approve or force-reject a pending workflow task, bypassing quorum'),
  ('workflow', 'delegation', 'read', 'Read workflow delegation/substitute assignments'),
  ('workflow', 'delegation', 'create', 'Create a workflow delegation/substitute assignment'),
  ('workflow', 'delegation', 'revoke', 'Revoke a workflow delegation/substitute assignment')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;

-- =========================================================================
-- 8. `awcms_mini_worker` least-privilege role grants (migration 045) —
--    the new escalation/timeout job (`bun run workflow:escalations:dispatch`)
-- =========================================================================

GRANT SELECT ON awcms_mini_workflow_definitions TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_workflow_instances TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_workflow_tasks TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_workflow_task_assignments TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_workflow_delegations TO awcms_mini_worker;

-- This job is a NEW producer of domain events (`workflow.task.escalated`,
-- see `domain-event-runtime/domain/event-type-registry.ts`) running as
-- `awcms_mini_worker` — migration 056 deliberately did not grant the
-- worker role INSERT on these two tables because its own reference
-- producer ran as `awcms_mini_app`; this job's producer call
-- (`appendDomainEvent`) runs inside the escalation job's OWN transaction
-- under the worker role, so the grant is added here by the new producer's
-- migration, exactly as `appendDomainEvent`'s doc comment expects of any
-- future producer module.
GRANT INSERT ON awcms_mini_domain_events TO awcms_mini_worker;
GRANT INSERT ON awcms_mini_domain_event_deliveries TO awcms_mini_worker;
