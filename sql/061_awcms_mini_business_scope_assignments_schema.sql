-- Issue #746 (epic #738 platform-evolution, Wave 2, ADR-0013 §2/§4) —
-- reusable business-scope assignments and segregation-of-duties (SoD)
-- policy hooks, owned by `identity_access`. Four tables, all tenant-scoped
-- (`ENABLE`+`FORCE ROW LEVEL SECURITY`), `tenant_id` first in every
-- composite index (doc 04 §RLS standard/§Index standard).
--
-- `scope_type`/`scope_id` is a GENERIC reference (text + uuid), never a
-- foreign key to any optional organization module's table (ADR-0013 §6 —
-- identity-access must not import/table-write to an org module that does
-- not exist yet). Validity/tenant-ownership of a given `(scope_type,
-- scope_id)` pair is checked at the APPLICATION layer through
-- `BusinessScopeHierarchyPort` (`_shared/ports/business-scope-hierarchy-
-- port.ts`), never trusted from request input alone (issue #746 security
-- requirement) and never enforced here as a DB-level FK (impossible anyway
-- across an unknown future table).
--
-- 1. `awcms_mini_business_scope_assignments` — one row = one tenant_user
--    granted a role/permission context restricted to one business scope,
--    with effective dates, temporary expiry, revocation, and
--    grantor/approver.
-- 2. `awcms_mini_business_scope_assignment_events` — append-only lifecycle
--    history (granted/revoked/expired/renewed) for (1).
-- 3. `awcms_mini_sod_conflict_exceptions` — the temporary exception/
--    override flow: a bounded-lifetime (no indefinite override) approval
--    to proceed despite a detected SoD conflict.
-- 4. `awcms_mini_sod_conflict_evaluations` — append-only decision log for
--    every SoD conflict check, mirroring `awcms_mini_abac_decision_logs`'s
--    shape/spirit (sql/005) — recorded regardless of outcome.
--
-- Self-grant/self-approval denial ("Self-grant/self-approval for high-risk
-- assignment or SoD exception is denied", issue #746 security requirement)
-- is an APPLICATION-level check (grantor/approver != subject, re-checked
-- from DB, never trusted from request body) — a SQL CHECK constraint
-- cannot express "these two uuid columns must differ from a THIRD table's
-- row values" across tables, so it is enforced in
-- `identity-access/application/business-scope-assignment-service.ts` and
-- `sod-exception-service.ts` instead, same convention `tenant-sso.ts`'s
-- break-glass re-check documents.
CREATE TABLE IF NOT EXISTS awcms_mini_business_scope_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  tenant_user_id uuid NOT NULL REFERENCES awcms_mini_tenant_users (id),
  role_id uuid REFERENCES awcms_mini_roles (id),
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  is_temporary boolean NOT NULL DEFAULT false,
  reason text,
  granted_by_tenant_user_id uuid NOT NULL REFERENCES awcms_mini_tenant_users (id),
  approved_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  status text NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoked_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_business_scope_assignments_status_check
    CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT awcms_mini_business_scope_assignments_scope_type_format_check
    CHECK (scope_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_business_scope_assignments_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- "A temporary assignment must have an end date" (issue #746 scope).
  CONSTRAINT awcms_mini_business_scope_assignments_temporary_has_end_check
    CHECK (is_temporary = false OR effective_to IS NOT NULL),
  CONSTRAINT awcms_mini_business_scope_assignments_revoked_consistency_check
    CHECK (
      (status <> 'revoked' AND revoked_at IS NULL AND revoked_by_tenant_user_id IS NULL)
      OR
      (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_tenant_user_id IS NOT NULL)
    )
);

-- Subject lookup: "what scopes/roles is this tenant_user currently assigned?"
CREATE INDEX IF NOT EXISTS awcms_mini_business_scope_assignments_subject_idx
  ON awcms_mini_business_scope_assignments (tenant_id, tenant_user_id, status);

-- Scope lookup: "who is assigned to this scope?"
CREATE INDEX IF NOT EXISTS awcms_mini_business_scope_assignments_scope_idx
  ON awcms_mini_business_scope_assignments (tenant_id, scope_type, scope_id, status);

-- Expiry job scan: active/temporary rows whose effective_to has passed.
CREATE INDEX IF NOT EXISTS awcms_mini_business_scope_assignments_expiry_idx
  ON awcms_mini_business_scope_assignments (tenant_id, effective_to)
  WHERE status = 'active' AND effective_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_business_scope_assignments_role_idx
  ON awcms_mini_business_scope_assignments (tenant_id, role_id)
  WHERE role_id IS NOT NULL;

ALTER TABLE awcms_mini_business_scope_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_business_scope_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_business_scope_assignments_tenant_isolation
  ON awcms_mini_business_scope_assignments
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only lifecycle history — never UPDATE/DELETE, matching every other
-- append-only audit-adjacent table in this repo (e.g.
-- `awcms_mini_abac_decision_logs`, sql/005).
CREATE TABLE IF NOT EXISTS awcms_mini_business_scope_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  assignment_id uuid NOT NULL REFERENCES awcms_mini_business_scope_assignments (id),
  event_type text NOT NULL,
  actor_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT awcms_mini_business_scope_assignment_events_event_type_check
    CHECK (event_type IN ('granted', 'revoked', 'expired', 'renewed'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_business_scope_assignment_events_assignment_idx
  ON awcms_mini_business_scope_assignment_events (tenant_id, assignment_id, occurred_at DESC);

ALTER TABLE awcms_mini_business_scope_assignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_business_scope_assignment_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_business_scope_assignment_events_tenant_isolation
  ON awcms_mini_business_scope_assignment_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Temporary exception/override to a detected SoD conflict. `rule_key`
-- matches a `SoDRuleDescriptor.ruleKey` from the CODE registry
-- (`identity-access/domain/sod-rule-registry.ts`) — deliberately NOT a
-- database foreign key, since the registry is code, not a table (same
-- convention `awcms_mini_data_lifecycle_legal_holds.descriptor_key`
-- already established for `HighVolumeTableDescriptor.key`, sql/057).
-- Exceptions MUST have an end date — "no indefinite override" (issue #746
-- scope) — `effective_to` is NOT NULL, unlike the assignment table's
-- optional `effective_to`.
CREATE TABLE IF NOT EXISTS awcms_mini_sod_conflict_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  rule_key text NOT NULL,
  subject_tenant_user_id uuid NOT NULL REFERENCES awcms_mini_tenant_users (id),
  scope_type text,
  scope_id uuid,
  justification text NOT NULL,
  requested_by_tenant_user_id uuid NOT NULL REFERENCES awcms_mini_tenant_users (id),
  approved_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  status text NOT NULL DEFAULT 'pending',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_sod_conflict_exceptions_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked')),
  CONSTRAINT awcms_mini_sod_conflict_exceptions_rule_key_format_check
    CHECK (rule_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_sod_conflict_exceptions_scope_pair_check
    CHECK ((scope_type IS NULL) = (scope_id IS NULL)),
  CONSTRAINT awcms_mini_sod_conflict_exceptions_effective_range_check
    CHECK (effective_to > effective_from)
  -- Self-approval denial ("requested_by_tenant_user_id != approved_by_
  -- tenant_user_id") is an APPLICATION-level rule, re-checked from DB, not
  -- a SQL CHECK — `approved_by_tenant_user_id` is only ever set by
  -- `sod-exception-service.ts`'s `approveSoDConflictException`, which
  -- re-reads the requester id from the row itself (never trusts a
  -- request-body value) before comparing against the acting approver.
);

CREATE INDEX IF NOT EXISTS awcms_mini_sod_conflict_exceptions_subject_idx
  ON awcms_mini_sod_conflict_exceptions (tenant_id, subject_tenant_user_id, status);

CREATE INDEX IF NOT EXISTS awcms_mini_sod_conflict_exceptions_rule_idx
  ON awcms_mini_sod_conflict_exceptions (tenant_id, rule_key, status);

-- Approved-exception validity lookup: "is there a currently-valid
-- exception for (rule_key, subject) covering this scope?" — partial index
-- on the only status the chokepoint actually queries at decision time.
CREATE INDEX IF NOT EXISTS awcms_mini_sod_conflict_exceptions_active_lookup_idx
  ON awcms_mini_sod_conflict_exceptions (tenant_id, rule_key, subject_tenant_user_id, effective_to)
  WHERE status = 'approved';

ALTER TABLE awcms_mini_sod_conflict_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_sod_conflict_exceptions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_sod_conflict_exceptions_tenant_isolation
  ON awcms_mini_sod_conflict_exceptions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only SoD conflict-check decision log — recorded regardless of
-- outcome (same "append-always" convention `awcms_mini_abac_decision_logs`
-- already established), mirroring its shape/spirit for SoD-specific facts.
CREATE TABLE IF NOT EXISTS awcms_mini_sod_conflict_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  rule_key text NOT NULL,
  subject_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  trigger_context text NOT NULL,
  conflict_detected boolean NOT NULL,
  resolved_via text NOT NULL DEFAULT 'none',
  decision_reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT awcms_mini_sod_conflict_evaluations_trigger_context_check
    CHECK (trigger_context IN ('assignment_create', 'high_risk_decision')),
  CONSTRAINT awcms_mini_sod_conflict_evaluations_resolved_via_check
    CHECK (resolved_via IN ('none', 'exception', 'denied'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_sod_conflict_evaluations_subject_idx
  ON awcms_mini_sod_conflict_evaluations (tenant_id, subject_tenant_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_sod_conflict_evaluations_rule_idx
  ON awcms_mini_sod_conflict_evaluations (tenant_id, rule_key, occurred_at DESC);

ALTER TABLE awcms_mini_sod_conflict_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_sod_conflict_evaluations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_sod_conflict_evaluations_tenant_isolation
  ON awcms_mini_sod_conflict_evaluations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_worker` (Issue #683, migration 045) grants — exactly what
-- `scripts/identity-access-business-scope-expiry.ts` touches: SELECT the
-- backlog, UPDATE assignments/exceptions past their `effective_to` to
-- `expired`, INSERT the resulting lifecycle event rows. No DELETE anywhere
-- (this job never removes a row, only transitions status) and no access to
-- `awcms_mini_sod_conflict_evaluations` (that table is only ever written by
-- the request-path chokepoint on `awcms_mini_app`, never the worker).
-- `awcms_mini_app` needs no explicit grant here: all four tables are
-- tenant-scoped (RLS FORCE'd), already covered by migration 013's
-- `ALTER DEFAULT PRIVILEGES` blanket grant (migration 045's own precedent).
GRANT SELECT, UPDATE ON awcms_mini_business_scope_assignments TO awcms_mini_worker;
GRANT SELECT, INSERT ON awcms_mini_business_scope_assignment_events TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_sod_conflict_exceptions TO awcms_mini_worker;
