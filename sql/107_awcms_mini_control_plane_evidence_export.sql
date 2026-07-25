-- Issue #930 (epic #868) Wave 5 — the operator evidence export permission.
--
-- ## Why this reuses `support_access` rather than inventing an activity
--
-- Exporting a tenant's control-plane evidence IS an exercise of support
-- access: a platform operator reaching into a tenant they do not belong to, for
-- a stated operational reason, for a bounded time. Migration 098 already built
-- exactly that as a maker/checker workflow with a second approver, a recorded
-- reason, and an auto-expiry window.
--
-- Hanging the export off the same activity means it inherits all of it. The
-- route requires BOTH this permission AND an approved, unrevoked, unexpired
-- grant for the specific target tenant (`hasActiveSupportGrant`), so the
-- permission on its own is not a standing key to the fleet — which is what a
-- separate, grant-less activity would have created.
--
-- The existing SoD rule `identity_access.support_request_vs_approve` therefore
-- covers this path unchanged: an operator still cannot approve their own
-- access, and the export cannot outlive the grant that authorized it.

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('identity_access', 'support_access', 'export',
   'Export a BOUNDED, MASKED, AUDITED control-plane evidence package for a target tenant (counts, statuses, and timestamps only — never provider references, envelopes, tokens, or PII). Requires an approved, unexpired support-access grant for that tenant in addition to this permission.')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
