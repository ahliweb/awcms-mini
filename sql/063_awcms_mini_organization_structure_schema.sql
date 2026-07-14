-- Issue #749 (epic #738 platform-evolution, Wave 2, ADR-0016) —
-- `organization_structure` module schema: legal entities, tenant-
-- configurable organization-unit types, organization units, an effective-
-- dated (SCD Type 2 style) parent-child unit hierarchy, operational
-- locations, a location<->unit many-to-many relationship, and effective-
-- dated party/unit assignments. Seven tables, all tenant-scoped
-- (`ENABLE`+`FORCE ROW LEVEL SECURITY`), `tenant_id` first in every
-- composite index (doc 04 §RLS standard/§Index standard).
--
-- Tenant vs legal entity vs organization unit remain DISTINCT concepts
-- (ADR-0013 §2) — the RLS predicate on every table below is ALWAYS AND
-- ONLY `tenant_id`. `legal_entity_id`/`unit_type_id`/`parent_organization_
-- unit_id`/`organization_unit_id`/`operational_location_id`/
-- `tenant_user_id` are ordinary foreign keys, re-validated for tenant
-- ownership at the APPLICATION layer on every write (same convention
-- `business-scope-assignment-service.ts` established for its own
-- `tenantUserId`/`roleId` checks) — Postgres has no cross-table composite
-- FK precedent in this repo (`sql/061` deliberately does not use one
-- either) to enforce "same tenant" at the DB constraint level, so this is
-- defense-in-depth done at the same layer as the rest of the codebase,
-- not a gap unique to this module.
--
-- 1. `awcms_mini_legal_entities` — tenant-scoped legal/business entity
--    (e.g. one PT/CV) with a GENERIC opaque registration identifier pair
--    (never a government-specific field name like NPWP/SIUP), full soft-
--    delete (deactivate is the normal end state, never hard delete).
-- 2. `awcms_mini_organization_unit_types` — tenant-configurable typed
--    vocabulary (department/branch/cost_center/warehouse/program_unit are
--    suggested seed examples documented in the module README, not
--    hardcoded rows here — every tenant defines its own).
-- 3. `awcms_mini_organization_units` — effective-dated unit, optionally
--    linked to a legal entity (never required — units directly under the
--    tenant are explicitly allowed) and optionally typed.
-- 4. `awcms_mini_organization_unit_hierarchies` — SCD Type 2 style
--    effective-dated parent-child edges. Reparenting NEVER updates
--    `parent_organization_unit_id` in place — it closes the currently-open
--    row (`effective_to = now()`) and inserts a new one. The partial
--    unique index below (`effective_to IS NULL`) guarantees at most ONE
--    open edge per unit at the database level, which is what makes
--    "no overlapping effective periods for the same unit" true by
--    construction, not just an application-level promise. No-cycle/
--    self-parent validation cannot be expressed as a CHECK constraint
--    (requires graph traversal) — see `domain/organization-unit-
--    hierarchy.ts` (pure validator) and `application/organization-unit-
--    hierarchy-service.ts` (transactional writer, `pg_advisory_xact_lock`
--    + `SELECT ... FOR UPDATE`) for where it is actually enforced, in the
--    SAME transaction as every write path.
-- 5. `awcms_mini_operational_locations` — physical location, fully
--    optional lat/lng validated to [-90,90]/[-180,180] via CHECK.
-- 6. `awcms_mini_location_unit_relationships` — explicit many-to-many
--    join table between locations and units, itself effective-dated
--    (issue #749 acceptance criterion: "locations, relationships ...
--    support effective dates and as-of queries").
-- 7. `awcms_mini_organization_unit_assignments` — effective-dated
--    assignment of an `identity_access` tenant user to a unit, with an
--    optional plain-string position/responsibility label (explicitly NOT
--    an HR/payroll hierarchy). `tenant_user_id` references
--    `awcms_mini_tenant_users` (owned by `identity_access`, a declared
--    lifecycle dependency of this module, so Optional -> Core is an
--    allowed DAG direction) — this does NOT create a duplicate person/
--    party registry (ADR-0013 §4 no-shared-table-write / single profile
--    owner rule), it only references the existing tenant user row.

CREATE TABLE IF NOT EXISTS awcms_mini_legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  name text NOT NULL,
  registration_identifier text,
  registration_identifier_label text,
  status text NOT NULL DEFAULT 'active',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_legal_entities_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT awcms_mini_legal_entities_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT awcms_mini_legal_entities_registration_pair_check
    CHECK (registration_identifier IS NULL OR registration_identifier_label IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS awcms_mini_legal_entities_tenant_idx
  ON awcms_mini_legal_entities (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_mini_legal_entities_tenant_status_idx
  ON awcms_mini_legal_entities (tenant_id, status)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_legal_entities FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_legal_entities_tenant_isolation
  ON awcms_mini_legal_entities
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_organization_unit_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
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
  CONSTRAINT awcms_mini_organization_unit_types_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT awcms_mini_organization_unit_types_code_format_check
    CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_organization_unit_types_tenant_code_key
  ON awcms_mini_organization_unit_types (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_organization_unit_types_tenant_idx
  ON awcms_mini_organization_unit_types (tenant_id, deleted_at);

ALTER TABLE awcms_mini_organization_unit_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_organization_unit_types FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_organization_unit_types_tenant_isolation
  ON awcms_mini_organization_unit_types
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_organization_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  legal_entity_id uuid REFERENCES awcms_mini_legal_entities (id),
  unit_type_id uuid REFERENCES awcms_mini_organization_unit_types (id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_organization_units_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT awcms_mini_organization_units_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_organization_units_tenant_code_key
  ON awcms_mini_organization_units (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_organization_units_tenant_idx
  ON awcms_mini_organization_units (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_mini_organization_units_tenant_status_idx
  ON awcms_mini_organization_units (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_organization_units_legal_entity_idx
  ON awcms_mini_organization_units (tenant_id, legal_entity_id)
  WHERE legal_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_organization_units_unit_type_idx
  ON awcms_mini_organization_units (tenant_id, unit_type_id)
  WHERE unit_type_id IS NOT NULL;

ALTER TABLE awcms_mini_organization_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_organization_units FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_organization_units_tenant_isolation
  ON awcms_mini_organization_units
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_organization_unit_hierarchies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  organization_unit_id uuid NOT NULL REFERENCES awcms_mini_organization_units (id),
  parent_organization_unit_id uuid REFERENCES awcms_mini_organization_units (id),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  reason text,
  changed_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_organization_unit_hierarchies_no_self_parent_check
    CHECK (parent_organization_unit_id IS NULL OR parent_organization_unit_id <> organization_unit_id),
  CONSTRAINT awcms_mini_organization_unit_hierarchies_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Guarantees AT MOST ONE open (current) parent edge per unit at the
-- database level — the concurrency backstop behind the tenant-wide
-- `pg_advisory_xact_lock` the application layer also takes (see
-- `application/organization-unit-hierarchy-service.ts`): even if the
-- advisory lock were somehow bypassed, this index makes a second
-- concurrent "open a new current edge for the same unit" INSERT fail
-- with a unique-violation rather than silently create two overlapping
-- current periods.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_organization_unit_hierarchies_current_key
  ON awcms_mini_organization_unit_hierarchies (tenant_id, organization_unit_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_organization_unit_hierarchies_unit_history_idx
  ON awcms_mini_organization_unit_hierarchies (tenant_id, organization_unit_id, effective_from DESC);

-- Children/tree-building lookup: "who are the current (or as-of) children
-- of this parent?"
CREATE INDEX IF NOT EXISTS awcms_mini_organization_unit_hierarchies_parent_idx
  ON awcms_mini_organization_unit_hierarchies (tenant_id, parent_organization_unit_id, effective_from);

ALTER TABLE awcms_mini_organization_unit_hierarchies ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_organization_unit_hierarchies FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_organization_unit_hierarchies_tenant_isolation
  ON awcms_mini_organization_unit_hierarchies
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_operational_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  name text NOT NULL,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country_code text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
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
  CONSTRAINT awcms_mini_operational_locations_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT awcms_mini_operational_locations_latitude_range_check
    CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  CONSTRAINT awcms_mini_operational_locations_longitude_range_check
    CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  CONSTRAINT awcms_mini_operational_locations_coordinate_pair_check
    CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX IF NOT EXISTS awcms_mini_operational_locations_tenant_idx
  ON awcms_mini_operational_locations (tenant_id, deleted_at);

ALTER TABLE awcms_mini_operational_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_operational_locations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_operational_locations_tenant_isolation
  ON awcms_mini_operational_locations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_location_unit_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  operational_location_id uuid NOT NULL REFERENCES awcms_mini_operational_locations (id),
  organization_unit_id uuid NOT NULL REFERENCES awcms_mini_organization_units (id),
  relationship_type text NOT NULL DEFAULT 'primary',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  ended_at timestamptz,
  ended_by uuid,
  CONSTRAINT awcms_mini_location_unit_relationships_type_check
    CHECK (relationship_type IN ('primary', 'secondary')),
  CONSTRAINT awcms_mini_location_unit_relationships_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- At most one OPEN relationship per (location, unit) pair — same
-- database-level concurrency backstop pattern as the hierarchy table
-- above, and what makes "no overlapping relationship periods" true for
-- this table without needing its own advisory lock (relationship
-- create/end never depends on ancestor/descendant graph traversal the way
-- hierarchy reparenting does, so a plain unique-partial-index + re-read-
-- before-write is sufficient here).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_location_unit_relationships_current_key
  ON awcms_mini_location_unit_relationships (tenant_id, operational_location_id, organization_unit_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_location_unit_relationships_location_idx
  ON awcms_mini_location_unit_relationships (tenant_id, operational_location_id, effective_to);

CREATE INDEX IF NOT EXISTS awcms_mini_location_unit_relationships_unit_idx
  ON awcms_mini_location_unit_relationships (tenant_id, organization_unit_id, effective_to);

ALTER TABLE awcms_mini_location_unit_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_location_unit_relationships FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_location_unit_relationships_tenant_isolation
  ON awcms_mini_location_unit_relationships
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_organization_unit_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  organization_unit_id uuid NOT NULL REFERENCES awcms_mini_organization_units (id),
  tenant_user_id uuid NOT NULL REFERENCES awcms_mini_tenant_users (id),
  position_label text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  status text NOT NULL DEFAULT 'active',
  reason text,
  assigned_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  ended_at timestamptz,
  ended_by_tenant_user_id uuid REFERENCES awcms_mini_tenant_users (id),
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_organization_unit_assignments_status_check
    CHECK (status IN ('active', 'ended')),
  CONSTRAINT awcms_mini_organization_unit_assignments_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT awcms_mini_organization_unit_assignments_ended_consistency_check
    CHECK (
      (status <> 'ended' AND ended_at IS NULL AND ended_by_tenant_user_id IS NULL)
      OR
      (status = 'ended' AND ended_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS awcms_mini_organization_unit_assignments_subject_idx
  ON awcms_mini_organization_unit_assignments (tenant_id, tenant_user_id, status);

CREATE INDEX IF NOT EXISTS awcms_mini_organization_unit_assignments_unit_idx
  ON awcms_mini_organization_unit_assignments (tenant_id, organization_unit_id, status);

-- "Expiring soon" metric scan: active assignments with a bounded end date.
CREATE INDEX IF NOT EXISTS awcms_mini_organization_unit_assignments_expiry_idx
  ON awcms_mini_organization_unit_assignments (tenant_id, effective_to)
  WHERE status = 'active' AND effective_to IS NOT NULL;

ALTER TABLE awcms_mini_organization_unit_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_organization_unit_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_organization_unit_assignments_tenant_isolation
  ON awcms_mini_organization_unit_assignments
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_worker` (Issue #683, migration 045) grants — this module has
-- no scheduled job that mutates data yet (the metrics snapshot job, `bun
-- run organization-structure:metrics-snapshot`, is READ-ONLY, see
-- `application/organization-structure-metrics-snapshot.ts`), but the
-- worker role still needs SELECT to compute gauges (active units,
-- hierarchy depth, expiring assignments) outside a request/ABAC context.
-- No INSERT/UPDATE/DELETE grants for the worker role on any table in this
-- module — every mutation here happens on the `awcms_mini_app` request
-- path (already covered by migration 013's `ALTER DEFAULT PRIVILEGES`
-- blanket grant, migration 045/061's own precedent for RLS-FORCE'd
-- tenant-scoped tables).
GRANT SELECT ON awcms_mini_legal_entities TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_organization_unit_types TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_organization_units TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_organization_unit_hierarchies TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_operational_locations TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_location_unit_relationships TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_organization_unit_assignments TO awcms_mini_worker;
