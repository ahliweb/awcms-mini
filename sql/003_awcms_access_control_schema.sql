-- 003 — RBAC + ABAC access control (doc 04/17).
-- Tanpa BEGIN/COMMIT — runner membungkus dalam transaction.

-- Katalog permission global: module_key.activity_code.action mengikuti
-- registry module & activity (doc 17). Global karena memetakan kemampuan
-- kode, bukan data tenant.
CREATE TABLE IF NOT EXISTS awcms_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL,
  activity_code text NOT NULL,
  action text NOT NULL
    CHECK (action IN ('read', 'create', 'update', 'delete', 'post', 'cancel',
                      'approve', 'export', 'send', 'configure', 'analyze', 'assign')),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_key, activity_code, action)
);

-- Role per tenant (seed default saat setup wizard, doc 17).
CREATE TABLE IF NOT EXISTS awcms_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  role_code text NOT NULL,
  role_name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE (tenant_id, role_code)
);

CREATE TABLE IF NOT EXISTS awcms_role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  role_id uuid NOT NULL REFERENCES awcms_roles (id),
  permission_id uuid NOT NULL REFERENCES awcms_permissions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_awcms_role_permissions_role
  ON awcms_role_permissions (role_id);
CREATE INDEX IF NOT EXISTS idx_awcms_role_permissions_permission
  ON awcms_role_permissions (permission_id);

CREATE TABLE IF NOT EXISTS awcms_tenant_user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  tenant_user_id uuid NOT NULL REFERENCES awcms_tenant_users (id),
  role_id uuid NOT NULL REFERENCES awcms_roles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, tenant_user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_awcms_tenant_user_roles_user
  ON awcms_tenant_user_roles (tenant_user_id);
CREATE INDEX IF NOT EXISTS idx_awcms_tenant_user_roles_role
  ON awcms_tenant_user_roles (role_id);

-- ABAC policy per tenant: default deny, deny overrides allow (doc 17).
CREATE TABLE IF NOT EXISTS awcms_abac_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  policy_code text NOT NULL,
  policy_name text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  module_key text,
  activity_code text,
  action text,
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE (tenant_id, policy_code)
);

CREATE INDEX IF NOT EXISTS idx_awcms_abac_policies_tenant_status
  ON awcms_abac_policies (tenant_id, status);

-- Decision log: deny high-risk wajib tercatat (doc 17).
CREATE TABLE IF NOT EXISTS awcms_abac_decision_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  tenant_user_id uuid REFERENCES awcms_tenant_users (id),
  module_key text NOT NULL,
  activity_code text NOT NULL,
  action text NOT NULL,
  resource_type text,
  resource_id uuid,
  allowed boolean NOT NULL,
  reason text NOT NULL,
  matched_policy text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awcms_abac_decision_logs_tenant_created
  ON awcms_abac_decision_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_awcms_abac_decision_logs_user
  ON awcms_abac_decision_logs (tenant_user_id);

-- ============ RLS tenant isolation ============
-- awcms_permissions global (katalog kode) — tanpa policy tenant.

ALTER TABLE awcms_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_roles_tenant_isolation ON awcms_roles;
CREATE POLICY awcms_roles_tenant_isolation ON awcms_roles
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_role_permissions_tenant_isolation ON awcms_role_permissions;
CREATE POLICY awcms_role_permissions_tenant_isolation ON awcms_role_permissions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_tenant_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_tenant_user_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_tenant_user_roles_tenant_isolation ON awcms_tenant_user_roles;
CREATE POLICY awcms_tenant_user_roles_tenant_isolation ON awcms_tenant_user_roles
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_abac_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_abac_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_abac_policies_tenant_isolation ON awcms_abac_policies;
CREATE POLICY awcms_abac_policies_tenant_isolation ON awcms_abac_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_abac_decision_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_abac_decision_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_abac_decision_logs_tenant_isolation ON awcms_abac_decision_logs;
CREATE POLICY awcms_abac_decision_logs_tenant_isolation ON awcms_abac_decision_logs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
