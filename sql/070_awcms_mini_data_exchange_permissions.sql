-- Issue #752 (epic #738 platform-evolution, Wave 3, ADR-0017) — permission
-- catalog seed for the `data_exchange` module. Same shape as
-- `sql/064_awcms_mini_organization_structure_permissions.sql`: additive
-- rows under a NEW `module_key`, reusing EXISTING `AccessAction` literals
-- rather than inventing new ones (`identity-access/domain/access-
-- control.ts`'s own documented "reuse existing approve/assign/read/create
-- rather than inventing redundant actions" precedent) — the ONE exception
-- is `imports.post`, the FIRST real consumer of the pre-existing `"post"`
-- literal (reserved since the initial union for exactly this "finalize a
-- staged transaction" shape, see that file's own comment on this addition).
--
-- `preview_errors.read` and `export_downloads.read` are DELIBERATELY
-- separate resources from `imports.read`/`exports.read` — Issue #752's own
-- security requirement: "Preview/error artifacts minimize and mask PII;
-- raw invalid values require explicit permission" and export FILE CONTENT
-- (not just job metadata) is more sensitive than the job's status/manifest.
-- `imports.manage` covers pause/resume of a long-running commit (reusing
-- the same generic `manage` action `domain_event_runtime` established for
-- consumer pause/resume, Issue #742).
-- `imports.post`/`imports.create`/`exports.create` are already classified
-- `HIGH_RISK_ACTIONS` in `access-control.ts` and additionally require
-- `Idempotency-Key` and are audited at the application layer.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('data_exchange', 'descriptors', 'read', 'Read the module-contributed exchange descriptor registry (code-declared metadata only)'),
  ('data_exchange', 'imports', 'read', 'Read/list staged import batches and their preview (masked values only)'),
  ('data_exchange', 'imports', 'create', 'Stage a new import batch (upload file, checksum/media-type verified)'),
  ('data_exchange', 'imports', 'post', 'Trigger the asynchronous idempotent commit of a previewed import batch'),
  ('data_exchange', 'imports', 'cancel', 'Cancel a staged import batch before commit begins'),
  ('data_exchange', 'imports', 'retry', 'Retry/resume a partially-committed or failed import batch'),
  ('data_exchange', 'imports', 'manage', 'Pause or resume an in-progress import batch'),
  ('data_exchange', 'preview_errors', 'read', 'Read raw (unmasked) invalid-row values in an import batch preview'),
  ('data_exchange', 'exports', 'read', 'Read/list export jobs and their manifest'),
  ('data_exchange', 'exports', 'create', 'Trigger a new export job'),
  ('data_exchange', 'exports', 'cancel', 'Cancel a queued or running export job'),
  ('data_exchange', 'export_downloads', 'read', 'Download an export job''s file content'),
  ('data_exchange', 'reconciliation', 'read', 'Read reconciliation reports for an import or export subject')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
