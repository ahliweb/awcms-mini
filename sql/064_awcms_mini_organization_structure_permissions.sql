-- Issue #749 (epic #738 platform-evolution, Wave 2, ADR-0016) — permission
-- catalog seed for the `organization_structure` module. Same shape as
-- `sql/062_awcms_mini_business_scope_permissions.sql`: additive rows under
-- a NEW `module_key`, reusing EXISTING `AccessAction` literals rather than
-- inventing new ones (`identity-access/domain/access-control.ts`'s own
-- documented "reuse existing approve/assign/read/create rather than
-- inventing redundant actions" precedent) — no change to that union in
-- this migration.
--
-- `legal_entities.delete`/`.restore` reuse the codebase-wide soft-delete
-- action pair: "delete" here means DEACTIVATE (soft-delete, never a hard
-- DELETE row) per issue #749's explicit "delete behavior is soft-delete/
-- deactivate by default" requirement.
-- `hierarchy.assign` is the single reparent mutation (create the first
-- parent edge for a unit, or change an existing one) — both are the exact
-- same "close current open edge, open a new one" write path
-- (`application/organization-unit-hierarchy-service.ts`), so one
-- permission covers both, mirroring `hierarchy.read` covering tree/
-- ancestor/descendant/as-of reads.
-- `location_unit_relationships.revoke`/`assignments.revoke` end an
-- effective-dated relationship/assignment (never a hard delete), reusing
-- the same `revoke` action `business_scope_assignments.revoke` (sql/062)
-- already established for "end an effective-dated grant".
-- All of delete/restore/assign/revoke are already classified
-- `HIGH_RISK_ACTIONS` in `access-control.ts` — reparent/deactivate/revoke
-- additionally require `Idempotency-Key` and are audited at the
-- application layer (`application/*-service.ts`), matching this epic's
-- established "isHighRiskAction is metadata, not the sole gate" pattern.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('organization_structure', 'legal_entities', 'read', 'Read legal entities for the caller''s tenant'),
  ('organization_structure', 'legal_entities', 'create', 'Create a legal entity'),
  ('organization_structure', 'legal_entities', 'update', 'Update a legal entity''s neutral metadata'),
  ('organization_structure', 'legal_entities', 'delete', 'Deactivate (soft-delete) a legal entity'),
  ('organization_structure', 'legal_entities', 'restore', 'Restore a previously deactivated legal entity'),
  ('organization_structure', 'unit_types', 'read', 'Read organization-unit types'),
  ('organization_structure', 'unit_types', 'create', 'Create an organization-unit type'),
  ('organization_structure', 'unit_types', 'update', 'Update an organization-unit type'),
  ('organization_structure', 'unit_types', 'delete', 'Soft-delete an organization-unit type'),
  ('organization_structure', 'unit_types', 'restore', 'Restore a soft-deleted organization-unit type'),
  ('organization_structure', 'units', 'read', 'Read/list/search organization units'),
  ('organization_structure', 'units', 'create', 'Create an organization unit'),
  ('organization_structure', 'units', 'update', 'Update an organization unit'),
  ('organization_structure', 'units', 'delete', 'Soft-delete an organization unit'),
  ('organization_structure', 'units', 'restore', 'Restore a soft-deleted organization unit'),
  ('organization_structure', 'hierarchy', 'read', 'Read organization-unit hierarchy edges, tree, and as-of history'),
  ('organization_structure', 'hierarchy', 'assign', 'Create or reparent an organization-unit hierarchy edge'),
  ('organization_structure', 'locations', 'read', 'Read operational locations'),
  ('organization_structure', 'locations', 'create', 'Create an operational location'),
  ('organization_structure', 'locations', 'update', 'Update an operational location'),
  ('organization_structure', 'locations', 'delete', 'Soft-delete an operational location'),
  ('organization_structure', 'locations', 'restore', 'Restore a soft-deleted operational location'),
  ('organization_structure', 'location_unit_relationships', 'read', 'Read location-to-unit relationships'),
  ('organization_structure', 'location_unit_relationships', 'create', 'Create a location-to-unit relationship'),
  ('organization_structure', 'location_unit_relationships', 'revoke', 'End a location-to-unit relationship'),
  ('organization_structure', 'assignments', 'read', 'Read organization-unit assignments'),
  ('organization_structure', 'assignments', 'create', 'Create an organization-unit assignment'),
  ('organization_structure', 'assignments', 'revoke', 'End an organization-unit assignment')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
