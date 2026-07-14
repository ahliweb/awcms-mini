-- Issue #751 security-review follow-up (Critical finding, PR #780) —
-- confidentiality-tier read permissions for `document_infrastructure`.
-- `confidentiality_level` (public/internal/confidential/restricted,
-- sql/066) was stored on every document but never consulted for access
-- decisions — holding only the base `documents.read` permission let any
-- tenant user read `confidential`/`restricted` documents identically to
-- `public` ones (full 200 response, no distinction, no deny).
--
-- Seeds two ADDITIVE, tier-specific read permissions — same "separate
-- read permission gates an extra field/record tier" pattern
-- `visitor_analytics.raw_detail.read` already establishes for this
-- codebase (`sql/038_awcms_mini_visitor_analytics_permissions.sql`).
-- NOT a hierarchy: holding `documents_restricted.read` does not imply
-- `documents_confidential.read` or vice versa — each tier is granted
-- independently, matching `raw_detail.read`'s own "no hierarchy/
-- implication between them in the DB" precedent. `public`/`internal`
-- documents remain readable to anyone holding the base `documents.read`
-- permission alone — no new permission required for those two tiers.
--
-- Enforcement (not this migration's job, see the accompanying code
-- change): `application/document-directory.ts`'s `listDocuments`/
-- `fetchDocumentById`/`listDocumentsByPrimaryResource` now require an
-- explicit `ConfidentialityReadAccess` argument
-- (`domain/document.ts`'s `isConfidentialityLevelReadable`/
-- `readableConfidentialityLevels`, both pure — the route handler is the
-- only place that resolves these two permission keys against
-- `auth.grantedPermissionKeys`, same "route decides the boolean, pure
-- function never resolves permissions itself" convention
-- `visitor-analytics/domain/analytics-response-shaping.ts`'s
-- `shapeVisitorSession` already establishes).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('document_infrastructure', 'documents_confidential', 'read', 'Read documents classified confidential (additive to the base documents.read permission, not implied by it)'),
  ('document_infrastructure', 'documents_restricted', 'read', 'Read documents classified restricted (additive to the base documents.read permission, not implied by it)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
