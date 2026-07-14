-- Issue #751 (epic #738 platform-evolution, Wave 3, ADR-0017) —
-- `document_infrastructure` module schema: a generic, tenant-scoped
-- document METADATA registry (immutable versions, classification,
-- generic resource relations, evidence, and concurrency-safe numbering
-- sequences). Deliberately infrastructure-only — never a domain document
-- schema (no letters/invoices/POs/journal batches/medical records/
-- contracts here, see ADR-0017 §2/§3 and issue #751's own Out of scope
-- list). Seven tables, all tenant-scoped (`ENABLE`+`FORCE ROW LEVEL
-- SECURITY`), `tenant_id` first in every composite index (doc 04 §RLS
-- standard/§Index standard).
--
-- 1. `awcms_mini_document_classifications` — tenant-scoped classification
--    catalog (code/name/description/confidentiality_level/
--    retention_reference). `retention_reference` is a free-text pointer a
--    tenant maps to a `data_lifecycle` policy key manually (ADR-0017 §4 —
--    deliberately NOT a foreign key/capability call in this PR, issue
--    #751 asks for retention integration "when available without hard
--    dependencies unless admitted").
-- 2. `awcms_mini_documents` — the document registry itself: stable id,
--    owner module (free text — this module never imports another
--    module's tables, ADR-0013 §6 no-shared-table-write), document type,
--    optional classification, status (active/superseded/archived/void),
--    title/summary, issued/effective dates, confidentiality level
--    (denormalized from classification at create time, may diverge
--    later via `reclassify`), retention reference, and a PRIMARY generic
--    resource reference (`resource_type`+`resource_id`, opaque strings —
--    the calling module's own primary key, never validated against a
--    foreign table this module cannot see). `current_version_number` is
--    a denormalized cache maintained ONLY by
--    `application/document-version-service.ts`'s append-only writer.
--    Soft-deletable (mistakenly created record) SEPARATELY from the
--    `status='void'` business-state transition (a voided document stays
--    visible/listed as evidence; a deleted one is removed from normal
--    listings) — two different concepts, not the same switch.
-- 3. `awcms_mini_document_versions` — IMMUTABLE, APPEND-ONLY (no
--    `updated_at`/`deleted_at` columns at all, and no UPDATE/DELETE
--    statement anywhere in this module's application code touches this
--    table — see `application/document-version-service.ts`'s own header).
--    `content_reference`/`content_reference_kind` point at an approved
--    managed-object storage contract (e.g. `sync_storage`'s object
--    queue key, or an external URL/system reference) — never a binary
--    blob column (issue #751 acceptance criterion). Corrections are a
--    NEW row with `previous_version_id` pointing backward, never an
--    in-place edit of an existing row.
-- 4. `awcms_mini_document_resource_relations` — additional TYPED
--    relationships from a document to one or more module-owned
--    resources, beyond the document's own primary `resource_type`/
--    `resource_id` above (e.g. one contract document also referenced as
--    evidence for an unrelated approval). Written ONLY through the
--    capability port (`application/document-resource-relation-port.ts`)
--    — no other module ever INSERTs into this table directly
--    (ADR-0013 §6).
-- 5. `awcms_mini_document_number_sequences` — concurrency-safe numbering
--    sequence DEFINITIONS, effective-dated SCD Type 2 style (same
--    pattern `awcms_mini_organization_unit_hierarchies`, migration 063,
--    already established for this codebase): revising the format/reset
--    policy NEVER updates a row in place — it closes the current open
--    definition (`effective_to = now()`) and opens a new one, carrying
--    `current_value`/`current_period_key` FORWARD so revising the
--    format never resets or reuses the counter. The partial unique
--    index below guarantees at most ONE open definition per
--    `(scope_type, scope_id, sequence_key)` at the database level.
-- 6. `awcms_mini_document_number_reservations` — one row per number ever
--    allocated from a sequence (reserved -> committed OR canceled).
--    `UNIQUE (tenant_id, sequence_id, reserved_number)` is what makes
--    "no silent number reuse" true BY CONSTRUCTION regardless of status
--    — a canceled reservation's number can never be re-issued because
--    the counter (`current_value`) only ever increases and this
--    constraint would reject any attempt to hand out that number again.
-- 7. `awcms_mini_document_evidence` — APPEND-ONLY durable evidence log
--    for numbering/version/document lifecycle events (reserved/
--    committed/canceled numbers; created/superseded versions; voided/
--    restored/reclassified documents; defined/revised/deactivated
--    sequence definitions). Complements (does not replace)
--    `awcms_mini_audit_events` — this is the domain-level evidence trail
--    issue #751 explicitly requires ("Add evidence records for
--    reserved/canceled/replaced/voided versions or numbers").

CREATE TABLE IF NOT EXISTS awcms_mini_document_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  confidentiality_level text NOT NULL DEFAULT 'internal',
  retention_reference text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_document_classifications_code_format_check
    CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_document_classifications_confidentiality_check
    CHECK (confidentiality_level IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT awcms_mini_document_classifications_status_check
    CHECK (status IN ('active', 'inactive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_document_classifications_tenant_code_key
  ON awcms_mini_document_classifications (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_document_classifications_tenant_idx
  ON awcms_mini_document_classifications (tenant_id, deleted_at);

ALTER TABLE awcms_mini_document_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_document_classifications FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_document_classifications_tenant_isolation
  ON awcms_mini_document_classifications
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  owner_module_key text NOT NULL,
  document_type text NOT NULL,
  classification_id uuid REFERENCES awcms_mini_document_classifications (id),
  status text NOT NULL DEFAULT 'active',
  title text NOT NULL,
  summary text,
  issued_at timestamptz,
  effective_at timestamptz,
  confidentiality_level text NOT NULL DEFAULT 'internal',
  retention_reference text,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  current_version_number integer NOT NULL DEFAULT 0,
  void_reason text,
  voided_at timestamptz,
  voided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_documents_owner_module_key_format_check
    CHECK (owner_module_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_documents_document_type_format_check
    CHECK (document_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_documents_status_check
    CHECK (status IN ('active', 'superseded', 'archived', 'void')),
  CONSTRAINT awcms_mini_documents_confidentiality_check
    CHECK (confidentiality_level IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT awcms_mini_documents_current_version_number_check
    CHECK (current_version_number >= 0),
  CONSTRAINT awcms_mini_documents_void_consistency_check
    CHECK (status <> 'void' OR voided_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS awcms_mini_documents_tenant_idx
  ON awcms_mini_documents (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_mini_documents_tenant_status_idx
  ON awcms_mini_documents (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_documents_classification_idx
  ON awcms_mini_documents (tenant_id, classification_id)
  WHERE classification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_documents_owner_module_idx
  ON awcms_mini_documents (tenant_id, owner_module_key);

-- The "generic resource reference" lookup: "which documents are attached
-- to THIS resource of mine?" — the core mechanism other modules rely on
-- via the capability port without ever seeing this table directly.
CREATE INDEX IF NOT EXISTS awcms_mini_documents_resource_idx
  ON awcms_mini_documents (tenant_id, resource_type, resource_id);

ALTER TABLE awcms_mini_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_documents_tenant_isolation
  ON awcms_mini_documents
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  document_id uuid NOT NULL REFERENCES awcms_mini_documents (id),
  version_number integer NOT NULL,
  content_reference text NOT NULL,
  content_reference_kind text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  source text NOT NULL DEFAULT 'upload',
  previous_version_id uuid REFERENCES awcms_mini_document_versions (id),
  created_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_document_versions_version_number_check
    CHECK (version_number > 0),
  CONSTRAINT awcms_mini_document_versions_content_reference_kind_check
    CHECK (content_reference_kind IN ('object_storage_reference', 'external_url', 'external_system_reference')),
  CONSTRAINT awcms_mini_document_versions_size_bytes_check
    CHECK (size_bytes >= 0),
  CONSTRAINT awcms_mini_document_versions_checksum_format_check
    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT awcms_mini_document_versions_source_check
    CHECK (source IN ('upload', 'import', 'generated', 'migrated'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_document_versions_document_version_key
  ON awcms_mini_document_versions (tenant_id, document_id, version_number);

CREATE INDEX IF NOT EXISTS awcms_mini_document_versions_document_idx
  ON awcms_mini_document_versions (tenant_id, document_id, version_number DESC);

ALTER TABLE awcms_mini_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_document_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_document_versions_tenant_isolation
  ON awcms_mini_document_versions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_document_resource_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  document_id uuid NOT NULL REFERENCES awcms_mini_documents (id),
  owner_module_key text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  relation_type text NOT NULL DEFAULT 'related_to',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_document_resource_relations_owner_module_key_format_check
    CHECK (owner_module_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_document_resource_relations_relation_type_check
    CHECK (relation_type IN ('evidence_for', 'attachment_of', 'reference_of', 'related_to', 'supersedes'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_document_resource_relations_active_key
  ON awcms_mini_document_resource_relations (tenant_id, document_id, owner_module_key, resource_type, resource_id, relation_type)
  WHERE deleted_at IS NULL;

-- Reverse lookup: "which documents are linked to THIS resource?" — the
-- other half of the capability port's read surface.
CREATE INDEX IF NOT EXISTS awcms_mini_document_resource_relations_resource_idx
  ON awcms_mini_document_resource_relations (tenant_id, resource_type, resource_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_document_resource_relations_document_idx
  ON awcms_mini_document_resource_relations (tenant_id, document_id)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_document_resource_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_document_resource_relations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_document_resource_relations_tenant_isolation
  ON awcms_mini_document_resource_relations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_document_number_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  scope_type text NOT NULL,
  scope_id text,
  sequence_key text NOT NULL,
  format_template text NOT NULL,
  reset_policy text NOT NULL DEFAULT 'never',
  current_period_key text,
  current_value bigint NOT NULL DEFAULT 0,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  revision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_document_number_sequences_scope_type_format_check
    CHECK (scope_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_document_number_sequences_sequence_key_format_check
    CHECK (sequence_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_document_number_sequences_format_template_length_check
    CHECK (char_length(format_template) BETWEEN 1 AND 128),
  CONSTRAINT awcms_mini_document_number_sequences_reset_policy_check
    CHECK (reset_policy IN ('never', 'yearly', 'monthly', 'daily')),
  CONSTRAINT awcms_mini_document_number_sequences_current_value_check
    CHECK (current_value >= 0),
  CONSTRAINT awcms_mini_document_number_sequences_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT awcms_mini_document_number_sequences_scope_id_not_blank_check
    CHECK (scope_id IS NULL OR btrim(scope_id) <> '')
);

-- At most ONE open (current) definition per (scope_type, scope_id,
-- sequence_key) — same database-level backstop pattern as
-- `awcms_mini_organization_unit_hierarchies_current_key` (migration 063).
-- `coalesce(scope_id, '')` treats a NULL (tenant-wide) scope as its own
-- distinct value for uniqueness purposes — validated at the application
-- layer to never accept an actual empty-string `scope_id` (see the CHECK
-- above and `domain/document-number-sequence.ts`), so this coalesce can
-- never collide a real scope_id with the tenant-wide sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_document_number_sequences_current_key
  ON awcms_mini_document_number_sequences (tenant_id, scope_type, (coalesce(scope_id, '')), sequence_key)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_document_number_sequences_scope_idx
  ON awcms_mini_document_number_sequences (tenant_id, scope_type, scope_id);

CREATE INDEX IF NOT EXISTS awcms_mini_document_number_sequences_history_idx
  ON awcms_mini_document_number_sequences (tenant_id, sequence_key, effective_from DESC);

ALTER TABLE awcms_mini_document_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_document_number_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_document_number_sequences_tenant_isolation
  ON awcms_mini_document_number_sequences
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_document_number_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  sequence_id uuid NOT NULL REFERENCES awcms_mini_document_number_sequences (id),
  reserved_number bigint NOT NULL,
  formatted_number text NOT NULL,
  period_key text,
  status text NOT NULL DEFAULT 'reserved',
  document_id uuid REFERENCES awcms_mini_documents (id),
  reserved_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  committed_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  canceled_at timestamptz,
  canceled_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  cancel_reason text,
  correlation_id text,
  CONSTRAINT awcms_mini_document_number_reservations_reserved_number_check
    CHECK (reserved_number > 0),
  CONSTRAINT awcms_mini_document_number_reservations_status_check
    CHECK (status IN ('reserved', 'committed', 'canceled')),
  CONSTRAINT awcms_mini_document_number_reservations_committed_consistency_check
    CHECK (status <> 'committed' OR (document_id IS NOT NULL AND committed_at IS NOT NULL)),
  CONSTRAINT awcms_mini_document_number_reservations_canceled_consistency_check
    CHECK (status <> 'canceled' OR (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);

-- THE structural guarantee behind "no silent number reuse" (issue #751
-- acceptance criterion) — holds regardless of a reservation's status
-- (reserved/committed/canceled all permanently occupy their slot).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_document_number_reservations_number_key
  ON awcms_mini_document_number_reservations (tenant_id, sequence_id, reserved_number);

CREATE INDEX IF NOT EXISTS awcms_mini_document_number_reservations_sequence_status_idx
  ON awcms_mini_document_number_reservations (tenant_id, sequence_id, status);

CREATE INDEX IF NOT EXISTS awcms_mini_document_number_reservations_document_idx
  ON awcms_mini_document_number_reservations (tenant_id, document_id)
  WHERE document_id IS NOT NULL;

ALTER TABLE awcms_mini_document_number_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_document_number_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_document_number_reservations_tenant_isolation
  ON awcms_mini_document_number_reservations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_document_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  evidence_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  document_id uuid REFERENCES awcms_mini_documents (id),
  sequence_id uuid REFERENCES awcms_mini_document_number_sequences (id),
  reservation_id uuid REFERENCES awcms_mini_document_number_reservations (id),
  actor_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_document_evidence_evidence_type_check
    CHECK (evidence_type IN (
      'number_reserved', 'number_committed', 'number_canceled',
      'version_created', 'document_voided', 'document_restored',
      'document_reclassified', 'sequence_defined', 'sequence_revised',
      'sequence_deactivated', 'sequence_restored'
    )),
  CONSTRAINT awcms_mini_document_evidence_subject_type_check
    CHECK (subject_type IN ('document', 'document_version', 'number_reservation', 'number_sequence'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_document_evidence_subject_idx
  ON awcms_mini_document_evidence (tenant_id, subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_document_evidence_document_idx
  ON awcms_mini_document_evidence (tenant_id, document_id)
  WHERE document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_document_evidence_sequence_idx
  ON awcms_mini_document_evidence (tenant_id, sequence_id)
  WHERE sequence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_document_evidence_tenant_created_idx
  ON awcms_mini_document_evidence (tenant_id, created_at DESC);

ALTER TABLE awcms_mini_document_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_document_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_document_evidence_tenant_isolation
  ON awcms_mini_document_evidence
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_worker` (migration 045) read-only grants — no scheduled job
-- in this module mutates data (all mutation happens on the
-- `awcms_mini_app` request path, already covered by migration 013's
-- `ALTER DEFAULT PRIVILEGES` blanket grant for tenant-scoped RLS-FORCE'd
-- tables, same precedent migration 064's own footer documents).
GRANT SELECT ON awcms_mini_document_classifications TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_documents TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_document_versions TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_document_resource_relations TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_document_number_sequences TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_document_number_reservations TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_document_evidence TO awcms_mini_worker;
