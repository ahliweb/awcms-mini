-- Issue #512 (epic #510, module management) — database-backed module
-- registry, tenant module lifecycle, dependency graph, settings,
-- navigation, jobs, and health-check history.
--
-- `awcms_mini_modules` already exists (migration 001) as a dormant table —
-- no application code has ever written to it (the code-level registry,
-- `src/modules/index.ts`, has been the only source of truth so far). This
-- migration extends it in place (never recreated) and adds the supporting
-- tables Issue #513's descriptor-sync service populates.
--
-- Deliberately does NOT add a `module_management.audit.read` permission or
-- a dedicated `awcms_mini_module_lifecycle_events` table (both were in the
-- original issue draft) — module lifecycle/config actions are recorded
-- through the existing generic `awcms_mini_audit_events` table
-- (`module_key = 'module_management'`, `resource_type` = 'tenant_module' /
-- 'module_settings' / etc.), the same audit trail every other module
-- already reuses (see `GET /api/v1/logs/audit?resourceType=...`). A second,
-- module-specific event table would just be a second, divergent source of
-- truth for the same fact ("who changed what, when") — exactly the
-- redundancy this epic's own Issue #517 (permission sync/status reporting)
-- exists to catch elsewhere, so it should not be introduced here either.
ALTER TABLE awcms_mini_modules
  ADD COLUMN IF NOT EXISTS module_type text,
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS descriptor_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_core boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_tenant_configurable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE awcms_mini_modules
  ADD CONSTRAINT awcms_mini_modules_lifecycle_status_check
    CHECK (lifecycle_status IN ('active', 'experimental', 'deprecated', 'maintenance', 'disabled'));

ALTER TABLE awcms_mini_modules
  ADD CONSTRAINT awcms_mini_modules_module_type_check
    CHECK (module_type IS NULL OR module_type IN ('base', 'system', 'domain', 'integration', 'derived'));

-- Tenant-level module enablement (Issue #515). A missing row for a given
-- (tenant, module) pair means "using the default" — enabled, matching
-- pre-epic behavior where every registered module was simply always on
-- for every tenant (epic #510 acceptance criterion: "Existing module
-- behavior remains backward-compatible").
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  enabled boolean NOT NULL DEFAULT true,
  enabled_at timestamptz,
  enabled_by uuid,
  disabled_at timestamptz,
  disabled_by uuid,
  disable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_tenant_modules_tenant_module_key UNIQUE (tenant_id, module_key)
);

ALTER TABLE awcms_mini_tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_modules FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_modules_tenant_isolation
  ON awcms_mini_tenant_modules
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_modules_tenant_idx
  ON awcms_mini_tenant_modules (tenant_id, module_key);

-- Dependency graph (Issue #515's validation reads this). Code-derived —
-- populated by Issue #513's descriptor sync from each module's own
-- `dependencies` array, never tenant-writable. RLS-free: this is global
-- registry metadata describing which module needs which, identical in
-- meaning for every tenant (same justification as `awcms_mini_modules`
-- itself being RLS-free since migration 001).
CREATE TABLE IF NOT EXISTS awcms_mini_module_dependencies (
  module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  depends_on_module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module_key, depends_on_module_key),
  CONSTRAINT awcms_mini_module_dependencies_no_self_dependency
    CHECK (module_key <> depends_on_module_key)
);

-- Tenant-aware, non-secret module settings (Issue #516). `settings` must
-- never hold a raw provider secret/token — enforced at the application
-- layer (redact/reject secret-shaped keys, reusing
-- `_shared/redaction.ts`'s `REDACTION_KEYS`), not by this schema.
CREATE TABLE IF NOT EXISTS awcms_mini_module_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  schema_version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT awcms_mini_module_settings_tenant_module_key UNIQUE (tenant_id, module_key)
);

ALTER TABLE awcms_mini_module_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_module_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_module_settings_tenant_isolation
  ON awcms_mini_module_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Admin navigation registry (Issue #518). Code-derived (synced from each
-- module descriptor's `navigation` entries), not tenant-writable — RLS-free
-- for the same reason as dependencies/jobs above. `path` is globally
-- unique: two modules declaring the same admin route would be a
-- descriptor-authoring bug, not a valid state.
CREATE TABLE IF NOT EXISTS awcms_mini_module_navigation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  label_key text NOT NULL,
  path text NOT NULL,
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  nav_group text,
  required_permission text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_module_navigation_path_key UNIQUE (path)
);

-- Operational job/command registry (Issue #519). Documentation-only —
-- never an "execute this command" surface. Code-derived, RLS-free.
CREATE TABLE IF NOT EXISTS awcms_mini_module_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  command text NOT NULL,
  purpose text NOT NULL,
  recommended_schedule text,
  environment_notes text,
  safe_in_offline_lan boolean NOT NULL DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_module_jobs_module_command_key UNIQUE (module_key, command)
);

-- Health check result history (Issue #520). Instance-level (schema
-- validity, migrations applied, permission catalog synced, provider config
-- present, etc. are facts about the deployed instance, not about any one
-- tenant) — RLS-free, same reasoning as the other registry tables above.
-- `message` must be redaction-ready (never a raw secret/stack trace) —
-- enforced at the application layer, same rule `email_delivery_attempts`
-- follows for provider response snippets.
CREATE TABLE IF NOT EXISTS awcms_mini_module_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL REFERENCES awcms_mini_modules (module_key),
  status text NOT NULL,
  message text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_module_health_checks_status_check
    CHECK (status IN ('healthy', 'degraded', 'failed', 'unknown'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_module_health_checks_module_idx
  ON awcms_mini_module_health_checks (module_key, checked_at DESC);

-- Permission catalog for Module Management (Issues #514-#520). No
-- `module_management.audit.read` — see header comment.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('module_management', 'modules', 'read', 'Read the module registry'),
  ('module_management', 'modules', 'sync', 'Sync trusted code descriptors into the database registry'),
  ('module_management', 'tenant_modules', 'read', 'Read tenant module enablement state'),
  ('module_management', 'tenant_modules', 'enable', 'Enable a module for a tenant'),
  ('module_management', 'tenant_modules', 'disable', 'Disable a module for a tenant'),
  ('module_management', 'settings', 'read', 'Read effective tenant module settings'),
  ('module_management', 'settings', 'update', 'Update tenant module settings'),
  ('module_management', 'permissions', 'read', 'Read module permission sync/status'),
  ('module_management', 'navigation', 'read', 'Read the module admin navigation registry'),
  ('module_management', 'jobs', 'read', 'Read the module job/command registry'),
  ('module_management', 'health', 'read', 'Read module health/readiness status'),
  ('module_management', 'health', 'check', 'Trigger a module health check')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
