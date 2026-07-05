ALTER TABLE awcms_mini_sync_push_batches
  ADD COLUMN IF NOT EXISTS conflicted_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS awcms_mini_sync_aggregate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  current_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_sync_aggregate_versions_key
  ON awcms_mini_sync_aggregate_versions (tenant_id, aggregate_type, aggregate_id);

ALTER TABLE awcms_mini_sync_aggregate_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_sync_aggregate_versions_tenant_isolation
  ON awcms_mini_sync_aggregate_versions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  node_id uuid NOT NULL REFERENCES awcms_mini_sync_nodes (id),
  batch_id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  conflict_type text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_sync_conflicts_conflict_type_check
    CHECK (conflict_type IN ('version_mismatch', 'missing_base_version')),
  CONSTRAINT awcms_mini_sync_conflicts_status_check
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT awcms_mini_sync_conflicts_resolution_check
    CHECK (resolution IS NULL OR resolution IN ('accept_incoming', 'keep_existing', 'manual'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_sync_conflicts_tenant_status_idx
  ON awcms_mini_sync_conflicts (tenant_id, status, created_at DESC);

ALTER TABLE awcms_mini_sync_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_sync_conflicts_tenant_isolation
  ON awcms_mini_sync_conflicts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('sync_storage', 'conflict_resolution', 'read', 'Read sync conflicts'),
  ('sync_storage', 'conflict_resolution', 'approve', 'Resolve sync conflicts')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
