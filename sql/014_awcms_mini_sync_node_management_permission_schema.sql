-- Admin Sync management (PR: Sync admin ops dashboard). Seeds the two
-- permissions the new session-authenticated sync node endpoints guard on:
-- `GET /api/v1/sync/nodes` (list) and `PATCH /api/v1/sync/nodes/{id}`
-- (activate/deactivate, rename). No schema change — `awcms_mini_sync_nodes`
-- (migration 007) already has the `status`/`node_name` columns these
-- endpoints read/update; this migration only extends the global permission
-- catalog, same as migrations 008/009 did for conflict_resolution/object_queue.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('sync_storage', 'node_management', 'read', 'Read sync node registrations'),
  ('sync_storage', 'node_management', 'update', 'Activate/deactivate or rename a sync node')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
