-- Issue #557 (epic #555, online public tenant routing & tenant domain
-- management) — database foundation for mapping a public hostname/domain/
-- subdomain to a tenant. Schema-only: no module descriptor (#558), no
-- host-based resolver (#559), no API (#562), no admin UI (#563). This
-- table is the input the future resolver reads to answer
-- "hostname -> tenant_id" without requiring `tenantCode` in the path
-- (`docs/awcms-mini/12_generator_prompt.md`'s epic target model, see
-- `.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md`).
--
-- Numbering note: the issue's own §Scope only names this one file
-- (`sql/031_awcms_mini_tenant_domain_schema.sql`), but this migration
-- follows the same "schema then permissions, two files" split
-- `blog_content` used for its own module foundation (026=schema,
-- 027=permissions; repeated again for 029/030's presentation extension) —
-- the closest precedent in this repo for "new module foundation table +
-- its permission catalog seed" landing together. Permission seed is
-- `sql/032_awcms_mini_tenant_domain_permissions.sql`.
--
-- Column design notes:
--   - `hostname` is the raw value as entered/observed (case preserved for
--     display); `normalized_hostname` is a separate stored column (not a
--     functional index on `lower(hostname)` — issue explicitly asks for a
--     column) holding the lowercase+trimmed form used for uniqueness and
--     resolver lookups. A CHECK constraint keeps the two in sync at the DB
--     layer as defense-in-depth (application code is still responsible for
--     populating both correctly on insert/update).
--   - `domain_type`: `subdomain` (under the operator's
--     `PUBLIC_PLATFORM_ROOT_DOMAIN`, config-only today per Issue #556) vs
--     `custom_domain` (tenant-owned external domain requiring its own DNS
--     verification).
--   - `route_mode`: which public route family this domain resolves into —
--     `canonical` (the new `/news` routes, Issue #560, under
--     `PUBLIC_CANONICAL_BASE_PATH`) vs `legacy_blog` (the existing
--     `/blog/{tenantCode}` routes, ADR-0009, documented as legacy but not
--     removed per epic #555's explicit out-of-scope). Not consumed by any
--     resolver yet — this issue only lays the column down.
--   - `status`: `pending_verification` (default; newly added, not yet
--     proven), `active` (verified and eligible to resolve tenant traffic),
--     `suspended` (operator/tenant paused it), `failed` (verification
--     failed or repeatedly errors on recheck). Soft delete
--     (`deleted_at`/`deleted_by`/`delete_reason`) is the fourth "does not
--     resolve traffic" state, not folded into this enum — same convention
--     `blog_content` posts/pages use (status enum + separate soft delete).
--     Security note from the issue is binding on whoever builds the
--     resolver (#559): suspended/failed/deleted rows must never resolve
--     public tenant traffic, and per the epic's tenant-existence-leak rule
--     (SKILL.md rule #5) an unknown/inactive host must look identical to
--     any other non-resolving host, not reveal which case it is.
--   - `is_primary` + `redirect_to_primary`: exactly one active primary
--     domain per tenant (enforced below by a partial unique index) is
--     where canonical URLs/redirects point; non-primary active domains can
--     optionally redirect to it (`redirect_to_primary`), enforcement of the
--     actual HTTP redirect is application-layer (future resolver/API
--     issue), not this migration's concern.
--   - `verification_method`: how ownership is being/was proven —
--     `dns_txt`/`dns_cname` (public DNS record, `verification_record_name`/
--     `verification_record_value` hold the record the tenant must publish,
--     never a secret), `file` (well-known file upload), or `manual`
--     (operator-attested, no automated check).
--   - `verification_token_hash`: sha256 hex, `sha256:`-prefixed — same
--     construction as `lib/auth/password-reset-token.ts`'s
--     `hashResetToken`/`profile-identity/domain/identifier.ts`'s
--     `hashIdentifier` (a CSPRNG-generated verification token is
--     high-entropy, so a fast hash is correct — no bcrypt/argon2 needed,
--     see those files' own comments for the full reasoning). The raw
--     token itself is never persisted; token generation/hashing/comparison
--     is application code for a later issue (#562), out of scope here.
--     `verification_record_value` is intentionally distinct: it is the
--     PUBLIC DNS record value the tenant publishes (not a secret), while
--     `verification_token_hash` is the hash of an internal bearer token
--     used for a different verification method. Neither column, nor any
--     other column on this table, ever stores a DNS provider API
--     credential/secret — those belong only in env/secret manager
--     (Cloudflare adapter, Issue #567, will follow the same
--     env-var-only pattern as the Mailketing/R2 provider config).
--
-- RLS bootstrap gotcha flagged for Issue #559 (resolver), not solved here:
-- FORCE RLS below with the standard `tenant_isolation` policy means a
-- query against this table with no `app.current_tenant_id` GUC set (the
-- `awcms_mini_app` role's fail-closed default, migration 013) returns zero
-- rows. That is correct and required for tenant-authenticated access
-- (#562's admin API must never see another tenant's domains), but the
-- whole point of the public host resolver is to discover tenant_id from
-- hostname BEFORE any tenant context exists — the same bootstrap problem
-- ADR-0009's `tenantCode -> tenant_id` lookup solves by querying
-- `awcms_mini_tenants`, which migration 013 deliberately left RLS-free
-- ("shared by design") for exactly this reason. This table cannot be
-- RLS-free the same way (it holds tenant-manageable fields like
-- `verification_token_hash`), so #559 will need its own bootstrap read
-- path for the hostname lookup step specifically — e.g. a narrowly-scoped
-- SECURITY DEFINER function returning only `(tenant_id, status,
-- is_primary)`, or a dedicated least-privilege read role for that one
-- query — rather than widening this table's RLS or having the app
-- connection bypass RLS generally. Do not remove FORCE RLS from this
-- table to work around it.
--
-- No explicit `GRANT` needed for `awcms_mini_app` on the new table below:
-- migration 013's `ALTER DEFAULT PRIVILEGES` already covers every table
-- the owning role creates from here on (same reasoning 025/026 relied on).

CREATE TABLE IF NOT EXISTS awcms_mini_tenant_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  hostname text NOT NULL,
  normalized_hostname text NOT NULL,
  domain_type text NOT NULL DEFAULT 'custom_domain',
  route_mode text NOT NULL DEFAULT 'canonical',
  status text NOT NULL DEFAULT 'pending_verification',
  is_primary boolean NOT NULL DEFAULT false,
  redirect_to_primary boolean NOT NULL DEFAULT false,
  verification_method text,
  verification_token_hash text,
  verification_record_name text,
  verification_record_value text,
  verified_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_tenant_domains_domain_type_check
    CHECK (domain_type IN ('subdomain', 'custom_domain')),
  CONSTRAINT awcms_mini_tenant_domains_route_mode_check
    CHECK (route_mode IN ('canonical', 'legacy_blog')),
  CONSTRAINT awcms_mini_tenant_domains_status_check
    CHECK (status IN ('pending_verification', 'active', 'suspended', 'failed')),
  CONSTRAINT awcms_mini_tenant_domains_verification_method_check
    CHECK (verification_method IS NULL
      OR verification_method IN ('dns_txt', 'dns_cname', 'file', 'manual')),
  CONSTRAINT awcms_mini_tenant_domains_hostname_not_blank_check
    CHECK (btrim(hostname) <> ''),
  CONSTRAINT awcms_mini_tenant_domains_normalized_hostname_matches_check
    CHECK (normalized_hostname = lower(btrim(hostname)))
);

-- Case-insensitive global uniqueness among active (non-deleted) rows — a
-- hostname can only ever map to one tenant, so this is intentionally NOT
-- scoped by tenant_id. Soft-deleting a row frees its normalized_hostname
-- for reuse (e.g. a domain moved off this platform, then re-added later).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_domains_normalized_hostname_dedup
  ON awcms_mini_tenant_domains (normalized_hostname)
  WHERE deleted_at IS NULL;

-- At most one active primary domain per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_domains_primary_dedup
  ON awcms_mini_tenant_domains (tenant_id)
  WHERE is_primary = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_domains_tenant_idx
  ON awcms_mini_tenant_domains (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_domains_tenant_status_idx
  ON awcms_mini_tenant_domains (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_tenant_domains_tenant_deleted_idx
  ON awcms_mini_tenant_domains (tenant_id, deleted_at);

ALTER TABLE awcms_mini_tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_domains FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_domains_tenant_isolation
  ON awcms_mini_tenant_domains
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
