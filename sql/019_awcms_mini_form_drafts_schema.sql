-- Issue #484 — Add server-side form draft persistence.
--
-- Generic, domain-agnostic draft store for the reusable wizard pattern
-- (Issue #479/#480, docs/awcms-mini/examples/wizard-form-pattern.md
-- §Server-side draft: follow-up, bukan MVP — that section's own suggested
-- schema is the starting point for this table). Deliberately deferred until
-- there was real evidence the pattern needed it: #482 (derived-module usage
-- example) and #483 (a real fixture in the admin shell) both landed first,
-- and the maintainer explicitly unblocked this issue afterward with a
-- concrete pilot plan (settings-form / admin/examples/wizard).
--
-- `resource_id` is `text`, not `uuid` as the doc's rough draft suggested —
-- reconciled here to match `awcms_mini_workflow_instances.resource_id` and
-- `awcms_mini_audit_events.resource_id` (both `text`), so a draft can
-- reference a not-yet-created resource or a non-UUID external identifier
-- without a type mismatch against the audit/workflow tables it sits next to.
--
-- No `restored_at`/`restored_by` columns (unlike the workflow tables) —
-- drafts are ephemeral scratch state, not an audited resource where restore
-- has meaning; `deleted_at`/`deleted_by`/`delete_reason` alone is enough for
-- the standard soft-delete convention.
--
-- FORCE RLS is applied inline in this same migration (not deferred to a
-- follow-up like migration 013 had to be) — every migration after 013 that
-- adds a new tenant-scoped table is expected to ENABLE+FORCE it immediately,
-- since the least-privilege `awcms_mini_app` role and its default DML grants
-- (`ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES`, migration 013) already
-- exist and auto-apply to this new table — no separate GRANT statement
-- needed here.
CREATE TABLE IF NOT EXISTS awcms_mini_form_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  module_key text NOT NULL,
  wizard_key text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  current_step text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  submitted_by uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_form_drafts_status_check
    CHECK (status IN ('draft', 'submitted', 'abandoned', 'expired')),
  CONSTRAINT awcms_mini_form_drafts_module_key_format_check
    CHECK (module_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT awcms_mini_form_drafts_wizard_key_format_check
    CHECK (wizard_key ~ '^[a-z][a-z0-9_]{1,63}$')
);

-- Listing "my active drafts for this wizard" is the primary read path (the
-- pilot's resume-on-load query) — index the tuple it filters on.
CREATE INDEX IF NOT EXISTS awcms_mini_form_drafts_tenant_wizard_idx
  ON awcms_mini_form_drafts (tenant_id, module_key, wizard_key, status);

CREATE INDEX IF NOT EXISTS awcms_mini_form_drafts_tenant_idx
  ON awcms_mini_form_drafts (tenant_id);

-- Retention job's query shape: WHERE tenant_id = ? AND status = 'draft' AND
-- expires_at < now() — see application/form-draft-purge.ts.
CREATE INDEX IF NOT EXISTS awcms_mini_form_drafts_tenant_expiry_idx
  ON awcms_mini_form_drafts (tenant_id, status, expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE awcms_mini_form_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_form_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_form_drafts_tenant_isolation
  ON awcms_mini_form_drafts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Permission model is generic infra, not gated per producing module_key —
-- same reasoning as awcms_mini_idempotency_keys (migration 012): RLS
-- already isolates by tenant; ABAC here answers "can this user use the
-- form-drafts API at all", not "can this user touch drafts belonging to
-- module X specifically". Module key shortened to "form_drafts" (matches
-- the table name), consistent with the "workflow"/"logging"/"reporting"
-- precedent of using a short base module key in code rather than doc 17's
-- domain-illustrative naming.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('form_drafts', 'draft', 'read', 'Read own tenant form drafts'),
  ('form_drafts', 'draft', 'create', 'Create a form draft'),
  ('form_drafts', 'draft', 'update', 'Update or submit a form draft'),
  ('form_drafts', 'draft', 'delete', 'Delete (abandon) a form draft')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
