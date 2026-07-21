-- Issue #879 (epic #868 SaaS control plane, Wave 2, ADR-0022 §5/§6) — two
-- cross-cutting security runtime mechanisms:
--
--   1. STEP-UP ASSURANCE SIGNAL (FIX MEDIUM-3). Adds `assurance_at` to sessions:
--      the actor's most recent strong-assurance instant. Set at session creation
--      (DEFAULT now()) and refreshable by a future re-assert/step-up endpoint
--      (#878). `access-guard.ts` denies a step-up-required control-plane action
--      (control-plane-step-up-registry.ts) when this is missing or older than the
--      registry window — turning the previously-vacuous registry into a real,
--      enforced, fail-closed control.
--
--   2. SUPPORT-ACCESS GRANTS (FIX MEDIUM-5). A platform/support operator has NO
--      standing right to read another tenant's records for troubleshooting. Every
--      cross-tenant support READ now requires an ACTIVE grant: scope-bound (a
--      grant is per TARGET tenant — never reusable for another tenant), time-bound
--      (auto-expiring `expires_at`), reason-bound (mandatory reason), approved by
--      a DISTINCT actor (SoD `identity_access.support_request_vs_approve`),
--      revocable, and independently auditable. Runtime enforcement lives at the
--      control-plane `_support.ts` composition-root read chokepoints; expiry and
--      revocation fail CLOSED.

-- --------------------------------------------------------------------------
-- 1. Step-up assurance signal on the existing session table.
-- --------------------------------------------------------------------------
ALTER TABLE awcms_mini_sessions
  ADD COLUMN IF NOT EXISTS assurance_at timestamptz NOT NULL DEFAULT now();

-- --------------------------------------------------------------------------
-- 2. Support-access grants (TENANT-SCOPED to the TARGET tenant). Every row is
--    scoped by `tenant_id` = the tenant being accessed; the RLS predicate is
--    ALWAYS AND ONLY `tenant_id` (ADR-0022 §6 High-1 — never a platform-claim
--    disjunction). A grant is looked up/created inside the TARGET tenant's
--    per-tenant context, so it can never be substituted across tenants.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS awcms_mini_control_plane_support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  -- The operator (identity) the grant authorizes to read THIS target tenant.
  operator_identity_id uuid NOT NULL REFERENCES awcms_mini_identities (id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  -- The auto-expiry window; set on approval. A grant is ACTIVE only while
  -- status='approved' AND now() < expires_at AND revoked_at IS NULL.
  expires_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_control_plane_support_access_grants_status_check
    CHECK (status IN ('requested', 'approved', 'revoked', 'rejected')),
  CONSTRAINT awcms_mini_control_plane_support_access_grants_reason_size_check
    CHECK (length(reason) BETWEEN 1 AND 2000),
  -- An approved grant must carry an approver and an expiry.
  CONSTRAINT awcms_mini_control_plane_support_access_grants_approved_shape_check
    CHECK (
      status <> 'approved'
      OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND expires_at IS NOT NULL)
    )
);

-- At most ONE live (requested or approved-not-revoked) grant per (tenant,
-- operator) — a fresh request must not stack on an existing live grant.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_control_plane_support_access_grants_live_key
  ON awcms_mini_control_plane_support_access_grants (tenant_id, operator_identity_id)
  WHERE status IN ('requested', 'approved') AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_control_plane_support_access_grants_active_idx
  ON awcms_mini_control_plane_support_access_grants (tenant_id, operator_identity_id, expires_at)
  WHERE status = 'approved' AND revoked_at IS NULL;

ALTER TABLE awcms_mini_control_plane_support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_control_plane_support_access_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_control_plane_support_access_grants_tenant_isolation
  ON awcms_mini_control_plane_support_access_grants
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Forward-legal + write-once trigger: identity immutable; transitions
-- requested -> {approved, rejected}, approved -> revoked only; approval/revocation
-- provenance write-once; never a backward move; expiry frozen once set.
CREATE OR REPLACE FUNCTION awcms_mini_control_plane_guard_support_grant_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.operator_identity_id IS DISTINCT FROM OLD.operator_identity_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'control_plane: support-access grant % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('revoked', 'rejected') THEN
    RAISE EXCEPTION 'control_plane: support-access grant % is terminal (status % is frozen)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected'))
      OR (OLD.status = 'approved'  AND NEW.status = 'revoked')
    ) THEN
      RAISE EXCEPTION 'control_plane: illegal support-access grant transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.approved_at IS NOT NULL
     AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
          OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'control_plane: support-access grant % approval provenance is write-once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_control_plane_support_access_grants_immutability
  BEFORE UPDATE ON awcms_mini_control_plane_support_access_grants
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_control_plane_guard_support_grant_immutability();

-- Never hard-deleted (evidence trail); revocation is a status, not a row destroy.
CREATE OR REPLACE FUNCTION awcms_mini_control_plane_guard_support_grant_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'control_plane: support-access grants are append-only (revoke, never delete)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_control_plane_support_access_grants_no_delete
  BEFORE DELETE ON awcms_mini_control_plane_support_access_grants
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_control_plane_guard_support_grant_no_delete();

-- --------------------------------------------------------------------------
-- 3. Support-access permissions (owned by identity_access — support access
--    follows the existing business-scope time-bound pattern, ADR-0022 §6).
--    Seeded default-deny (granted to no role here); a support-operator role is
--    provisioned narrowly by the deployment, separate from platform-operator.
-- --------------------------------------------------------------------------
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('identity_access', 'support_access', 'request', 'Request (MAKER) a time/reason-bound cross-tenant support-access grant for a specific target tenant.'),
  ('identity_access', 'support_access', 'approve', 'Approve (CHECKER) a support-access grant — a DIFFERENT actor than the requester (SoD support_request_vs_approve); sets the auto-expiry window.'),
  ('identity_access', 'support_access', 'revoke', 'Revoke an active support-access grant before its expiry.'),
  ('identity_access', 'support_access', 'read', 'Read support-access grants for a tenant (audit/investigation).')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
