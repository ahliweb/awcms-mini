-- Issue #750 (epic #738 platform-evolution, Wave 3, ADR-0021) — permission
-- catalog seed for the `reference_data` module. Same shape as
-- `sql/064_awcms_mini_organization_structure_permissions.sql`: additive
-- rows under a NEW `module_key`, reusing EXISTING `AccessAction` literals
-- where possible (`identity-access/domain/access-control.ts`'s own
-- documented "reuse existing approve/assign/read/create rather than
-- inventing redundant actions" precedent) and adding exactly two NEW
-- literals (`commit`, `rollback`) where no existing action fit the
-- import-commit/import-rollback semantics.
--
-- `value_sets.delete`/`.restore`, `codes.delete`/`.restore`, and
-- `tenant_codes.delete`/`.restore` reuse the codebase-wide soft-delete
-- action pair: "delete" here means DEPRECATE (soft, never a hard DELETE
-- row while referenced) per issue #750's explicit "A code already
-- referenced by business data is never silently deleted or repurposed in
-- place" requirement — exactly the same convention
-- `organization_structure.legal_entities.delete` (sql/064) already
-- established for its own soft-delete.
-- `imports.create` covers the non-mutating dry-run submission (computes a
-- diff, writes an import batch row, never touches `awcms_mini_reference_
-- codes`). `imports.commit`/`imports.rollback` are the two genuinely
-- mutating import actions — both classified `HIGH_RISK_ACTIONS` in
-- `access-control.ts` (this migration's companion code change) and both
-- require `Idempotency-Key` + audit at the application layer.
-- All of delete/restore/commit/rollback are already classified
-- `HIGH_RISK_ACTIONS` — every mutation in this module (create/update
-- included) requires `Idempotency-Key` at the application layer
-- regardless of this classification, matching this epic's established
-- "isHighRiskAction is metadata, not the sole gate" pattern.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('reference_data', 'value_sets', 'read', 'Read/list/search reference value sets'),
  ('reference_data', 'value_sets', 'create', 'Create a platform-curated reference value set'),
  ('reference_data', 'value_sets', 'update', 'Update a reference value set''s metadata'),
  ('reference_data', 'value_sets', 'delete', 'Deprecate (soft-delete) a reference value set'),
  ('reference_data', 'value_sets', 'restore', 'Restore a previously deprecated reference value set'),
  ('reference_data', 'codes', 'read', 'Read/list/search reference codes for a value set'),
  ('reference_data', 'codes', 'create', 'Create a reference code manually'),
  ('reference_data', 'codes', 'update', 'Update a reference code''s mutable attributes'),
  ('reference_data', 'codes', 'delete', 'Deprecate (soft-delete) a reference code'),
  ('reference_data', 'codes', 'restore', 'Restore a previously deprecated reference code'),
  ('reference_data', 'imports', 'read', 'Read/list reference data import batches'),
  ('reference_data', 'imports', 'create', 'Submit a non-mutating dry-run import for a value set'),
  ('reference_data', 'imports', 'commit', 'Commit a validated reference data import batch'),
  ('reference_data', 'imports', 'rollback', 'Roll back a committed reference data import batch'),
  ('reference_data', 'tenant_codes', 'read', 'Read/list the caller''s tenant reference code overrides/extensions'),
  ('reference_data', 'tenant_codes', 'create', 'Create a tenant reference code override or extension'),
  ('reference_data', 'tenant_codes', 'update', 'Update a tenant reference code override/extension'),
  ('reference_data', 'tenant_codes', 'delete', 'Deprecate (soft-delete) a tenant reference code override/extension'),
  ('reference_data', 'tenant_codes', 'restore', 'Restore a previously deprecated tenant reference code override/extension')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
