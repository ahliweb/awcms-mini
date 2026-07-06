-- Issue #498 (epic #492, follows schema Issue #494) — email template i18n
-- and restore support.
--
-- Converts `awcms_mini_email_templates`'s three body columns from plain
-- `text` to `jsonb` (per-locale), following doc 04 §Konten multi-bahasa's
-- "JSONB per-locale" pattern (`{ "en": "...", "id": "..." }`) — templates
-- are tenant DATA content (not static UI chrome), so they follow that
-- convention, not the `.po` gettext one. Chosen over a separate
-- translations table because templates are low-cardinality and always
-- read as a whole row (never queried/sorted per-locale), so a join adds
-- cost without benefit here (doc 04: "pilih per kebutuhan").
--
-- `USING jsonb_build_object('en', <column>)` backfills any pre-existing
-- row's single-locale text as its `en` entry — safe no-op today since no
-- real caller has enqueued/created a template yet (Issue #496/#497 land
-- after this one), but correct regardless.
ALTER TABLE awcms_mini_email_templates
  ALTER COLUMN subject_template TYPE jsonb
    USING jsonb_build_object('en', subject_template);

ALTER TABLE awcms_mini_email_templates
  ALTER COLUMN text_body_template TYPE jsonb
    USING (
      CASE WHEN text_body_template IS NULL THEN NULL
      ELSE jsonb_build_object('en', text_body_template) END
    );

ALTER TABLE awcms_mini_email_templates
  ALTER COLUMN html_body_template TYPE jsonb
    USING (
      CASE WHEN html_body_template IS NULL THEN NULL
      ELSE jsonb_build_object('en', html_body_template) END
    );

-- Restore support (doc 04 §Soft delete standard: "tambahkan restored_at/
-- restored_by bila restore didukung") — unlike `form_drafts` (scratch
-- state, restore not meaningful), a template is master/config data an
-- admin may legitimately want to undelete.
ALTER TABLE awcms_mini_email_templates
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by uuid;

-- Dedicated `restore` action (same precedent as `POST /profiles/{id}/restore`,
-- Issue 10.1 — a distinct action, not reused from `update`).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('email', 'template', 'restore', 'Restore a soft-deleted email template')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
