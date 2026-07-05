CREATE TABLE IF NOT EXISTS awcms_mini_object_sync_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  node_id uuid NOT NULL REFERENCES awcms_mini_sync_nodes (id),
  object_key text NOT NULL,
  local_path text NOT NULL,
  checksum_sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  requires_upload boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_error text,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_object_sync_queue_status_check
    CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT awcms_mini_object_sync_queue_byte_size_check
    CHECK (byte_size >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_key
  ON awcms_mini_object_sync_queue (tenant_id, node_id, object_key);

CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_retry_idx
  ON awcms_mini_object_sync_queue (tenant_id, status, next_retry_at);

ALTER TABLE awcms_mini_object_sync_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_object_sync_queue_tenant_isolation
  ON awcms_mini_object_sync_queue
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('sync_storage', 'object_queue', 'read', 'Read object sync queue entries'),
  ('sync_storage', 'object_queue', 'retry', 'Manually retry a failed object sync queue entry')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
