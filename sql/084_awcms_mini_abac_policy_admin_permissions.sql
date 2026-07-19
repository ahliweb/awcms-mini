-- Issue #179 — permission catalog rows for the ABAC policy authoring +
-- read-only simulation admin surface. Seeded here (mirroring how sql/005
-- seeds identity_access's other permissions directly, rather than via a
-- module descriptor `permissions` array which this module does not use) so
-- the new endpoints are reachable by a role that is explicitly granted them.
--
-- `awcms_mini_permissions` is a GLOBAL catalog (no tenant_id, no RLS — the
-- action VOCABULARY is process-wide; the tenant-scoped grant lives in
-- awcms_mini_role_permissions). Idempotent via ON CONFLICT DO NOTHING.
--
-- Actions reuse the existing `AccessAction` vocabulary (access-control.ts):
--   * read      — list/read stored policies.
--   * configure — create/update/enable/disable a policy (HIGH-RISK: authoring
--                 an access-control rule is security-sensitive; audited). A
--                 role that can `read` policies is NOT implicitly able to
--                 author them — separate action, default-deny.
--   * analyze   — run the read-only simulation/preview (hypothetical
--                 subject/resource/action -> decision). Its OWN action, held
--                 separately from `read`, so previewing decision logic can be
--                 granted or withheld independently. Read-only, not high-risk.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('identity_access', 'abac_policies', 'read', 'Read stored ABAC policies'),
  ('identity_access', 'abac_policies', 'configure', 'Author (create/update/enable/disable) ABAC policies'),
  ('identity_access', 'abac_policies', 'analyze', 'Run the read-only ABAC policy simulation/preview')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
