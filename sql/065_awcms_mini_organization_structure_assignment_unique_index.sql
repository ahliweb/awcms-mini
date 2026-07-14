-- Issue #749 (epic #738 platform-evolution, Wave 2, ADR-0016) — security
-- review follow-up on PR #779: `awcms_mini_organization_unit_assignments`
-- had NO uniqueness backstop on open (`status = 'active'`) assignments, so
-- a retried `POST /api/v1/organization-structure/assignments` (create) —
-- without an `Idempotency-Key`, since that endpoint had none until this
-- same follow-up — could silently insert two duplicate active-assignment
-- rows for the same `(tenant_id, organization_unit_id, tenant_user_id)`,
-- each independently endable and each firing its own event/audit entry.
--
-- Same "at most one OPEN row per key tuple" partial-unique-index pattern
-- `sql/063`'s `awcms_mini_location_unit_relationships_current_key` and
-- `awcms_mini_organization_unit_hierarchies_current_key` already
-- establish for this module — a plain unique-partial-index + re-read-
-- before-write app-level pre-check is sufficient here (assignment create
-- never depends on graph traversal the way hierarchy reparenting does, so
-- no advisory lock is needed).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_organization_unit_assignments_current_key
  ON awcms_mini_organization_unit_assignments (tenant_id, organization_unit_id, tenant_user_id)
  WHERE status = 'active';
