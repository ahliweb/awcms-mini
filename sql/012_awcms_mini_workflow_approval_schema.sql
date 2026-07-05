-- Issue 11.1 — Add Workflow Approval Engine.
--
-- Adds the generic workflow approval engine (doc 04 §Workflow: exactly 4
-- tables — definitions, instances, tasks, decisions; "steps" from the issue
-- scope is the ordered step list belonging to a definition, stored as jsonb,
-- not a 5th table). This base has no concrete business action that needs
-- approval-gating yet (no POS cancel/Coretax export/warehouse transfer —
-- those are domain-specific, out of scope, already excluded repeatedly in
-- prior issues); workflow definitions and instance-starting are therefore
-- internal-only (`startWorkflowInstance`, no public create endpoint), while
-- the public surface is exactly the decision API doc 17's seed model
-- sanctions: `workflow.approval.read` (list pending tasks) and
-- `workflow.approval.approve` (record a decision).
--
-- Also adds the generic idempotency store (`awcms_mini_idempotency_keys`,
-- doc 16 §Idempotency store: "key, request hash, status, response/resource")
-- required by doc 10 §Idempotency wrapper rules, which explicitly lists
-- "workflow decision" among the endpoints that require Idempotency-Key. No
-- prior issue has needed this table yet (no POS/warehouse/tax endpoints
-- exist in this generic base), so this is its first concrete consumer. Note:
-- doc 04's table-ownership matrix lists `awcms_mini_idempotency_keys` under
-- the illustrative "Sales POS" domain group — that grouping reflects where
-- the ERD document first introduces it as an example, not an exclusive
-- owner; doc 16 (backend data-access integration, not domain-specific)
-- documents it as shared cross-module infrastructure, so it is added here as
-- generic infra reusable by any future high-risk mutation, matching the
-- already-scaffolded (but previously unused) `IdempotencyKey` OpenAPI
-- parameter.
CREATE TABLE IF NOT EXISTS awcms_mini_workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  workflow_key text NOT NULL,
  name text NOT NULL,
  description text,
  steps jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_workflow_definitions_status_check
    CHECK (status IN ('active', 'inactive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_workflow_definitions_key_dedup
  ON awcms_mini_workflow_definitions (tenant_id, workflow_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_definitions_tenant_idx
  ON awcms_mini_workflow_definitions (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_definitions_tenant_deleted_idx
  ON awcms_mini_workflow_definitions (tenant_id, deleted_at);

ALTER TABLE awcms_mini_workflow_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_definitions_tenant_isolation
  ON awcms_mini_workflow_definitions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_workflow_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  workflow_definition_id uuid NOT NULL REFERENCES awcms_mini_workflow_definitions (id),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  current_step_order integer NOT NULL DEFAULT 1,
  requested_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_workflow_instances_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_instances_tenant_idx
  ON awcms_mini_workflow_instances (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_instances_definition_idx
  ON awcms_mini_workflow_instances (workflow_definition_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_instances_tenant_status_idx
  ON awcms_mini_workflow_instances (tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_instances_resource_idx
  ON awcms_mini_workflow_instances (tenant_id, resource_type, resource_id);

ALTER TABLE awcms_mini_workflow_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_instances_tenant_isolation
  ON awcms_mini_workflow_instances
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_workflow_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  workflow_instance_id uuid NOT NULL REFERENCES awcms_mini_workflow_instances (id),
  step_order integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_workflow_tasks_status_check
    CHECK (status IN ('pending', 'completed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_tasks_tenant_idx
  ON awcms_mini_workflow_tasks (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_tasks_instance_idx
  ON awcms_mini_workflow_tasks (workflow_instance_id);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_tasks_tenant_status_idx
  ON awcms_mini_workflow_tasks (tenant_id, status, created_at);

ALTER TABLE awcms_mini_workflow_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_tasks_tenant_isolation
  ON awcms_mini_workflow_tasks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only / immutable, same convention as `awcms_mini_abac_decision_logs`
-- (migration 005) and `awcms_mini_audit_events` (migration 011): a single
-- tenant-isolation RLS policy, no UPDATE ever issued against this table by
-- application code (recorded once per decision, never edited).
CREATE TABLE IF NOT EXISTS awcms_mini_workflow_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  workflow_task_id uuid NOT NULL REFERENCES awcms_mini_workflow_tasks (id),
  decision text NOT NULL,
  decided_by_tenant_user_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_workflow_decisions_decision_check
    CHECK (decision IN ('approve', 'reject'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_decisions_tenant_idx
  ON awcms_mini_workflow_decisions (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_workflow_decisions_task_idx
  ON awcms_mini_workflow_decisions (workflow_task_id);

ALTER TABLE awcms_mini_workflow_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_workflow_decisions_tenant_isolation
  ON awcms_mini_workflow_decisions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Generic idempotency store (doc 16 §Idempotency store, doc 10 §Idempotency
-- wrapper rules). `request_scope` disambiguates concurrent uses of the same
-- Idempotency-Key value across different mutation endpoints (e.g. a future
-- POS posting endpoint reusing this same table would use a different scope
-- string than `workflow_task_decision`).
CREATE TABLE IF NOT EXISTS awcms_mini_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  request_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_idempotency_keys_scope_key
  ON awcms_mini_idempotency_keys (tenant_id, request_scope, idempotency_key);

CREATE INDEX IF NOT EXISTS awcms_mini_idempotency_keys_tenant_created_idx
  ON awcms_mini_idempotency_keys (tenant_id, created_at DESC);

ALTER TABLE awcms_mini_idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_idempotency_keys_tenant_isolation
  ON awcms_mini_idempotency_keys
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Guards GET /workflows/tasks and POST /workflows/tasks/{id}/decisions.
-- Matches doc 17 seed table exactly: only read/approve, no create/configure
-- (no public create-definition/start-instance endpoint by design).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('workflow', 'approval', 'read', 'Read workflow tasks and instances'),
  ('workflow', 'approval', 'approve', 'Record a workflow task decision')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
