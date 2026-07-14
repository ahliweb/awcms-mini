-- Issue #754 (epic `platform-evolution` #738, Wave 3) — permission catalog
-- seed for `integration_hub`. Verbatim match to `src/modules/
-- integration-hub/domain/integration-permissions.ts`'s
-- `INTEGRATION_HUB_PERMISSIONS` (single source of truth reused by
-- `module.ts`, this migration, and every route handler — same convention
-- `data-lifecycle-permissions.ts`/`sql/058` already established).
--
-- Default-deny: no role is granted any of these here — role/permission
-- assignment stays an explicit `identity_access` admin action (doc 17).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('integration_hub', 'endpoints', 'read', 'Read inbound webhook endpoint configuration (secret pointers only, never resolved secret values)'),
  ('integration_hub', 'endpoints', 'create', 'Register a new inbound webhook endpoint'),
  ('integration_hub', 'endpoints', 'delete', 'Soft-delete an inbound webhook endpoint'),
  ('integration_hub', 'endpoints', 'configure', 'Rotate an inbound webhook endpoint secret'),
  ('integration_hub', 'endpoints', 'enable', 'Resume a paused inbound webhook endpoint'),
  ('integration_hub', 'endpoints', 'disable', 'Pause an inbound webhook endpoint'),
  ('integration_hub', 'subscriptions', 'read', 'Read outbound event subscriptions'),
  ('integration_hub', 'subscriptions', 'create', 'Register a new outbound event subscription'),
  ('integration_hub', 'subscriptions', 'delete', 'Soft-delete an outbound event subscription'),
  ('integration_hub', 'subscriptions', 'enable', 'Resume a paused outbound event subscription'),
  ('integration_hub', 'subscriptions', 'disable', 'Pause an outbound event subscription'),
  ('integration_hub', 'deliveries', 'read', 'Read inbound/outbound delivery status and attempt history, including dead-lettered deliveries'),
  ('integration_hub', 'deliveries', 'replay', 'Replay a failed/dead-lettered outbound delivery to a subscription'),
  ('integration_hub', 'health', 'read', 'Read adapter up/down/degraded health state'),
  ('integration_hub', 'adapters', 'read', 'Read the static provider adapter registry (code-declared metadata only)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
