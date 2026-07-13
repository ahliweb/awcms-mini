-- Issue #748 (epic #738 platform-evolution, Wave 2) — completes the
-- `profile_identity` foundation (migration 003) into a full canonical
-- party lifecycle: effective-dated identifier/address/channel provenance,
-- generic party-to-party relationships (no hardcoded business roles),
-- duplicate-candidate detection, and a real merge workflow (field-conflict
-- + reference-impact snapshots, approval gate, immutable merge history).
--
-- Security requirement (issue body, "cross-tenant matching/merge is
-- strictly prohibited"): every table below is tenant-scoped with
-- `ENABLE`+`FORCE ROW LEVEL SECURITY` and a tenant-first index, matching
-- the standard this repo has used since migration 013/045/057 (Issue
-- #683/#745). The 7 pre-existing profile-identity tables (migration 003)
-- already got `FORCE ROW LEVEL SECURITY` back in migration
-- `013_awcms_mini_enforce_rls_least_privilege.sql` (PR #777 review
-- correction — an earlier draft of this comment incorrectly claimed they
-- predated that standard) — section 1 below re-issues the same `ALTER
-- ... FORCE ROW LEVEL SECURITY` statements as a harmless, idempotent
-- no-op, purely for this migration's own self-contained readability
-- (every new/changed table in this file explicitly shows its RLS
-- posture), not because it closes any real gap. RLS is defense in depth
-- here, not the only guard — every application-layer query in this
-- issue's `application/` code additionally filters `tenant_id`
-- explicitly, and merge EXECUTION re-validates both profiles belong to
-- the caller's own tenant before doing anything (see
-- `application/merge-workflow.ts`'s `executeMergeRequest`).
--
-- No new `awcms_mini_app` grants needed: every table here is
-- tenant-scoped and RLS FORCE'd, so migration 013's
-- `ALTER DEFAULT PRIVILEGES` (kept by migration 045) already covers
-- future tenant-scoped tables for the web-runtime role. No new
-- `awcms_mini_worker` grants either — duplicate-candidate generation runs
-- on-demand inside an ordinary tenant-scoped request (`analyze` guard),
-- not as a scheduled worker job, so it never runs as `awcms_mini_worker`.

-- ---------------------------------------------------------------------
-- 1. Re-affirm FORCE RLS on the 7 pre-existing tables (migration 003) —
--    already applied by migration 013; these are harmless no-ops kept
--    for this migration's own self-contained readability.
-- ---------------------------------------------------------------------

ALTER TABLE awcms_mini_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_identifiers FORCE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_channels FORCE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_addresses FORCE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_entity_links FORCE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_merge_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_audit_logs FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2. Identifiers: provenance, verification metadata, effective dates
-- ---------------------------------------------------------------------

ALTER TABLE awcms_mini_profile_identifiers
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'self_reported',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid,
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

ALTER TABLE awcms_mini_profile_identifiers
  ADD CONSTRAINT awcms_mini_profile_identifiers_provenance_check
    CHECK (provenance IN (
      'self_reported', 'verified_by_staff', 'imported', 'system_generated'
    ));

ALTER TABLE awcms_mini_profile_identifiers
  ADD CONSTRAINT awcms_mini_profile_identifiers_validity_window_check
    CHECK (valid_until IS NULL OR valid_until > valid_from);

-- ---------------------------------------------------------------------
-- 3. Channels: effective dates + verification metadata (preferred flag
--    already exists as `is_default` — README documents that this column
--    IS the preferred-channel-per-type flag, no redundant new column).
-- ---------------------------------------------------------------------

ALTER TABLE awcms_mini_profile_channels
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid;

ALTER TABLE awcms_mini_profile_channels
  ADD CONSTRAINT awcms_mini_profile_channels_validity_window_check
    CHECK (valid_until IS NULL OR valid_until > valid_from);

-- ---------------------------------------------------------------------
-- 4. Addresses: effective dates (`is_default` already the preferred flag)
-- ---------------------------------------------------------------------

ALTER TABLE awcms_mini_profile_addresses
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

ALTER TABLE awcms_mini_profile_addresses
  ADD CONSTRAINT awcms_mini_profile_addresses_validity_window_check
    CHECK (valid_until IS NULL OR valid_until > valid_from);

-- ---------------------------------------------------------------------
-- 5. Party-to-party relationships (generic, no hardcoded business role
--    vocabulary — `relationship_type` is free text validated at the
--    application layer, domain/relationship.ts's `validateRelationshipType`
--    normalizes to snake_case and rejects empty/overlong values only, it
--    never restricts to a fixed enum of business roles like
--    customer/supplier/employee). An authorized-representative record is
--    just another relationship row with `is_authorized_representative =
--    true` and an optional free-text `representation_scope` describing the
--    authority granted — a structural/legal concept applicable regardless
--    of business domain, not a hardcoded domain role itself.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_mini_profile_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  from_profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  to_profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  relationship_type text NOT NULL,
  is_authorized_representative boolean NOT NULL DEFAULT false,
  representation_scope text,
  status text NOT NULL DEFAULT 'active',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  ended_by uuid,
  ended_at timestamptz,
  end_reason text,
  CONSTRAINT awcms_mini_profile_relationships_status_check
    CHECK (status IN ('active', 'ended')),
  CONSTRAINT awcms_mini_profile_relationships_distinct_parties_check
    CHECK (from_profile_id <> to_profile_id),
  CONSTRAINT awcms_mini_profile_relationships_validity_window_check
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT awcms_mini_profile_relationships_type_shape_check
    CHECK (relationship_type ~ '^[a-z][a-z0-9_]{1,63}$')
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_relationships_tenant_idx
  ON awcms_mini_profile_relationships (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_relationships_tenant_from_idx
  ON awcms_mini_profile_relationships (tenant_id, from_profile_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_relationships_tenant_to_idx
  ON awcms_mini_profile_relationships (tenant_id, to_profile_id);

-- Prevent literal duplicate active relationships of the same type between
-- the same ordered pair (re-adding after `status = 'ended'` is allowed).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_profile_relationships_active_key
  ON awcms_mini_profile_relationships (
    tenant_id, from_profile_id, to_profile_id, relationship_type
  )
  WHERE status = 'active';

ALTER TABLE awcms_mini_profile_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_relationships FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_relationships_tenant_isolation
  ON awcms_mini_profile_relationships
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ---------------------------------------------------------------------
-- 6. Duplicate candidates: deterministic + heuristic, explainable,
--    reviewable (a `not_duplicate` decision must stick — see the
--    `ON CONFLICT ... DO UPDATE ... WHERE status = 'pending'` upsert in
--    `application/duplicate-candidate-directory.ts`, which never
--    overwrites a row a human has already reviewed).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_mini_profile_duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_id_a uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  profile_id_b uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  match_basis text NOT NULL,
  match_score numeric(5, 4),
  match_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_profile_duplicate_candidates_basis_check
    CHECK (match_basis IN (
      'deterministic_identifier', 'heuristic_name_similarity', 'heuristic_combined'
    )),
  CONSTRAINT awcms_mini_profile_duplicate_candidates_status_check
    CHECK (status IN ('pending', 'confirmed_duplicate', 'not_duplicate')),
  CONSTRAINT awcms_mini_profile_duplicate_candidates_score_range_check
    CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 1)),
  -- Ordered pair (a < b) so the same unordered pair is never stored twice
  -- regardless of detection order.
  CONSTRAINT awcms_mini_profile_duplicate_candidates_ordered_pair_check
    CHECK (profile_id_a < profile_id_b)
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_duplicate_candidates_tenant_idx
  ON awcms_mini_profile_duplicate_candidates (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_duplicate_candidates_tenant_status_idx
  ON awcms_mini_profile_duplicate_candidates (tenant_id, status);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_duplicate_candidates_profile_a_idx
  ON awcms_mini_profile_duplicate_candidates (profile_id_a);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_duplicate_candidates_profile_b_idx
  ON awcms_mini_profile_duplicate_candidates (profile_id_b);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_profile_duplicate_candidates_pair_key
  ON awcms_mini_profile_duplicate_candidates (tenant_id, profile_id_a, profile_id_b);

ALTER TABLE awcms_mini_profile_duplicate_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_duplicate_candidates FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_duplicate_candidates_tenant_isolation
  ON awcms_mini_profile_duplicate_candidates
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ---------------------------------------------------------------------
-- 7. Merge requests: extend the migration-003 table with idempotent,
--    approval-gated, concurrency-safe execution state.
-- ---------------------------------------------------------------------

ALTER TABLE awcms_mini_profile_merge_requests
  ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS field_conflict_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reference_impact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS duplicate_candidate_id uuid
    REFERENCES awcms_mini_profile_duplicate_candidates (id),
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS executed_by uuid;

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_requests_duplicate_candidate_idx
  ON awcms_mini_profile_merge_requests (duplicate_candidate_id);

-- ---------------------------------------------------------------------
-- 8. Immutable merge history — append-only, distinct from the mutable
--    `awcms_mini_profile_merge_requests` status row. No application code
--    ever UPDATEs or DELETEs a row here; this is the record an operator
--    reasons about/recovers from after a merge (survivor/loser ids,
--    executed-by/at, and the same field-conflict/reference-impact
--    snapshot the merge request itself carried at execution time).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_mini_profile_merge_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  merge_request_id uuid NOT NULL REFERENCES awcms_mini_profile_merge_requests (id),
  survivor_profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  loser_profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  executed_by uuid NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  field_conflict_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_impact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_links_repointed_count integer NOT NULL DEFAULT 0,
  recovery_notes text,
  CONSTRAINT awcms_mini_profile_merge_history_distinct_parties_check
    CHECK (survivor_profile_id <> loser_profile_id)
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_history_tenant_idx
  ON awcms_mini_profile_merge_history (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_history_merge_request_idx
  ON awcms_mini_profile_merge_history (merge_request_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_history_survivor_idx
  ON awcms_mini_profile_merge_history (tenant_id, survivor_profile_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_history_loser_idx
  ON awcms_mini_profile_merge_history (tenant_id, loser_profile_id);

ALTER TABLE awcms_mini_profile_merge_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_profile_merge_history FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_merge_history_tenant_isolation
  ON awcms_mini_profile_merge_history
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ---------------------------------------------------------------------
-- 9. Permission catalog seed. `profile_management.{read,create,update,
--    delete,restore,purge}` and `profile_merge.{read,approve}` already
--    exist (migrations 005/011) — only the genuinely new activity
--    codes/actions this issue's endpoints need are added here.
-- ---------------------------------------------------------------------

INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('profile_identity', 'profile_merge', 'create', 'Create a profile merge request'),
  ('profile_identity', 'profile_merge', 'merge', 'Execute an approved profile merge request'),
  ('profile_identity', 'identifiers', 'read', 'Read profile identifiers (masked by default)'),
  ('profile_identity', 'identifiers', 'create', 'Add a profile identifier'),
  ('profile_identity', 'identifiers', 'update', 'Update a profile identifier (verification, validity window)'),
  ('profile_identity', 'identifiers', 'delete', 'Soft delete a profile identifier'),
  ('profile_identity', 'addresses', 'read', 'Read profile addresses'),
  ('profile_identity', 'addresses', 'create', 'Add a profile address'),
  ('profile_identity', 'addresses', 'update', 'Update a profile address'),
  ('profile_identity', 'addresses', 'delete', 'Soft delete a profile address'),
  ('profile_identity', 'channels', 'read', 'Read profile communication channels'),
  ('profile_identity', 'channels', 'create', 'Add a profile communication channel'),
  ('profile_identity', 'channels', 'update', 'Update a profile communication channel'),
  ('profile_identity', 'channels', 'delete', 'Soft delete a profile communication channel'),
  ('profile_identity', 'relationships', 'read', 'Read party-to-party relationships'),
  ('profile_identity', 'relationships', 'create', 'Create a party-to-party relationship'),
  ('profile_identity', 'relationships', 'delete', 'End an active party-to-party relationship'),
  ('profile_identity', 'duplicate_candidates', 'read', 'Read duplicate-candidate records'),
  ('profile_identity', 'duplicate_candidates', 'analyze', 'Trigger an on-demand duplicate-candidate scan'),
  ('profile_identity', 'duplicate_candidates', 'update', 'Review a duplicate candidate (confirm or mark false positive)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
