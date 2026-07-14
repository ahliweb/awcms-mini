-- Issue #751 (epic #738 platform-evolution, Wave 3, ADR-0017) —
-- permission catalog seed for the `document_infrastructure` module. Same
-- shape as `sql/064_awcms_mini_organization_structure_permissions.sql`:
-- additive rows under a NEW `module_key`, reusing EXISTING `AccessAction`
-- literals where the existing vocabulary already fits (`read`, `create`,
-- `update`, `delete`, `restore`, `assign`, `revoke`, `cancel`) and adding
-- four NEW literals only where nothing existing captures the meaning
-- (`void`, `reclassify`, `reserve`, `commit` — see
-- `identity-access/domain/access-control.ts`'s own `AccessAction`
-- union/`HIGH_RISK_ACTIONS` set, updated in the same PR).
--
-- `documents.delete`/`.restore` reuse the codebase-wide soft-delete pair
-- (mistakenly-created record removed from normal listings) — DISTINCT
-- from `documents.void`/`.restore` which is a BUSINESS-STATE transition
-- (an invalidated-but-still-visible-as-evidence document); both `delete`
-- and `void` end states reuse the SAME `restore` action to return to
-- `active`/undeleted, since a document can only be in one of those
-- states at a time (voiding a soft-deleted document or vice versa is
-- rejected by the application layer, not modeled as separate actions).
-- `relations.assign`/`.revoke` (link/unlink a document to a resource)
-- reuse `hierarchy.assign`/`business_scope_assignments.revoke`'s exact
-- action vocabulary (sql/064/062) rather than inventing "link"/"unlink".
-- `sequences.reserve`/`.commit`/`.cancel-via-reservations.cancel` are the
-- three numbering-integrity operations issue #751 names explicitly
-- ("reservation, commit, cancel, and gap evidence"); `cancel` reuses the
-- existing base `AccessAction` literal (already declared, never
-- previously added to `HIGH_RISK_ACTIONS` — this migration's
-- `access-control.ts` companion change adds `reserve`/`commit`/`void`/
-- `reclassify` to that set, deliberately leaving the pre-existing shared
-- `cancel` literal's classification untouched to avoid changing blast
-- radius for OTHER modules' `cancel` actions; this module's own
-- reservation-cancel route still requires `Idempotency-Key`
-- unconditionally at the route layer regardless of that classification,
-- matching the documented "isHighRiskAction is metadata, not the sole
-- gate" precedent).
-- `evidence.read` is the only action on that resource — evidence rows
-- are written internally by this module's own services, never through a
-- direct create/update/delete endpoint (append-only).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('document_infrastructure', 'classifications', 'read', 'Read document classifications for the caller''s tenant'),
  ('document_infrastructure', 'classifications', 'create', 'Create a document classification'),
  ('document_infrastructure', 'classifications', 'update', 'Update a document classification''s neutral metadata'),
  ('document_infrastructure', 'classifications', 'delete', 'Deactivate (soft-delete) a document classification'),
  ('document_infrastructure', 'classifications', 'restore', 'Restore a previously deactivated document classification'),
  ('document_infrastructure', 'documents', 'read', 'Read/list/search documents'),
  ('document_infrastructure', 'documents', 'create', 'Create a document registry entry'),
  ('document_infrastructure', 'documents', 'update', 'Update a document''s neutral metadata (title/summary/dates)'),
  ('document_infrastructure', 'documents', 'delete', 'Soft-delete a mistakenly created document registry entry'),
  ('document_infrastructure', 'documents', 'restore', 'Restore a soft-deleted document, or un-void a voided document'),
  ('document_infrastructure', 'documents', 'void', 'Void a document (irreversible-by-default business-state transition, kept visible as evidence)'),
  ('document_infrastructure', 'documents', 'reclassify', 'Change a document''s classification and/or confidentiality level'),
  ('document_infrastructure', 'versions', 'read', 'Read/list document versions'),
  ('document_infrastructure', 'versions', 'create', 'Create a new (append-only) document version'),
  ('document_infrastructure', 'relations', 'read', 'Read document-to-resource relations'),
  ('document_infrastructure', 'relations', 'assign', 'Link a document to a module-owned resource'),
  ('document_infrastructure', 'relations', 'revoke', 'Unlink a document from a module-owned resource'),
  ('document_infrastructure', 'sequences', 'read', 'Read number sequence definitions and history'),
  ('document_infrastructure', 'sequences', 'create', 'Define a new number sequence'),
  ('document_infrastructure', 'sequences', 'update', 'Revise a number sequence''s format/reset policy (effective-dated, counter carried forward)'),
  ('document_infrastructure', 'sequences', 'delete', 'Deactivate a number sequence'),
  ('document_infrastructure', 'sequences', 'restore', 'Reactivate a deactivated number sequence'),
  ('document_infrastructure', 'reservations', 'read', 'Read number reservations'),
  ('document_infrastructure', 'reservations', 'reserve', 'Reserve the next number from a sequence'),
  ('document_infrastructure', 'reservations', 'commit', 'Commit a reserved number to a document'),
  ('document_infrastructure', 'reservations', 'cancel', 'Cancel a reserved (not yet committed) number, recorded as gap evidence'),
  ('document_infrastructure', 'evidence', 'read', 'Read the document/numbering evidence trail')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
