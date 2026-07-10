-- Issue #618 (epic: visitor analytics #617-#624) — tenant-scoped schema
-- for visitor presence (`awcms_mini_visitor_sessions`), individual page
-- view/API events (`awcms_mini_visit_events`), and pre-aggregated daily
-- statistics (`awcms_mini_visitor_daily_rollups`). Schema-only issue —
-- no middleware collector (#620), user-agent parser (#619), API/dashboard
-- (#621/#622), or rollup/retention job (#624) exist yet; this migration
-- only lays the tables down.
--
-- Deliberately NOT audit tables and NOT soft-deletable master/config data
-- (AGENTS.md rule 13 does not apply here): these are high-volume,
-- log-like analytics rows, same shape as `awcms_mini_audit_events`
-- (migration 011) — no `deleted_at`/`deleted_by`/`delete_reason` columns.
-- Lifecycle is retention-based purge (Issue #624's job), not soft
-- delete/restore.
--
-- Privacy notes (binding on every later issue that writes to these
-- tables, see `src/modules/visitor-analytics/README.md`):
--   - `ip_address` (raw) is nullable and must only ever be populated when
--     `VISITOR_ANALYTICS_RAW_IP_ENABLED=true` (Issue #617's config gate).
--     Default privacy-first operation relies on `ip_hash`/
--     `user_agent_hash`/`visitor_key_hash` plus already-parsed
--     browser/device fields, never the raw values.
--   - `login_identifier_snapshot` is nullable and must never be populated
--     for anonymous public visitors — only for authenticated sessions,
--     as a point-in-time display convenience (the FK `identity_id` is the
--     source of truth; a login identifier can change after the snapshot
--     was taken).
--   - No request body, cookie, Authorization header, password reset
--     token, OAuth code, or query-string secret is ever stored in any
--     column here, including the two `jsonb` catch-alls
--     (`user_agent_parsed`, `geo`) — both are populated only from
--     derived/parsed values (Issue #619/#623), never raw request data.
--
-- RLS: `ENABLE` + `FORCE` + the standard `tenant_isolation` policy on all
-- three tables, same pattern as every other tenant-scoped table since
-- migration 013 (see `sql/031_awcms_mini_tenant_domain_schema.sql` for
-- the closest precedent). No explicit `GRANT` needed for
-- `awcms_mini_app` — migration 013's `ALTER DEFAULT PRIVILEGES` already
-- covers every table the owning role creates from here on.

CREATE TABLE IF NOT EXISTS awcms_mini_visitor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  visitor_key_hash text NOT NULL,
  identity_id uuid REFERENCES awcms_mini_identities (id),
  login_identifier_snapshot text,
  is_authenticated boolean NOT NULL DEFAULT false,
  area text NOT NULL,
  current_path text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  ip_address inet,
  user_agent_hash text,
  browser_name text,
  browser_version_major text,
  os_name text,
  device_type text,
  is_human boolean NOT NULL DEFAULT true,
  bot_reason text,
  country_code text,
  region text,
  city text,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_visitor_sessions_area_check
    CHECK (area IN ('admin', 'public', 'api', 'auth', 'setup', 'unknown')),
  CONSTRAINT awcms_mini_visitor_sessions_device_type_check
    CHECK (device_type IS NULL
      OR device_type IN ('desktop', 'mobile', 'tablet', 'bot', 'unknown'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_visitor_sessions_tenant_last_seen_idx
  ON awcms_mini_visitor_sessions (tenant_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_visitor_sessions_tenant_area_last_seen_idx
  ON awcms_mini_visitor_sessions (tenant_id, area, last_seen_at DESC);

ALTER TABLE awcms_mini_visitor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_visitor_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_visitor_sessions_tenant_isolation
  ON awcms_mini_visitor_sessions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_visit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  visitor_session_id uuid REFERENCES awcms_mini_visitor_sessions (id),
  identity_id uuid REFERENCES awcms_mini_identities (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  status_code integer,
  area text NOT NULL,
  route_pattern text,
  path_sanitized text NOT NULL,
  referrer_domain text,
  duration_ms integer,
  ip_hash text,
  user_agent_hash text,
  user_agent_parsed jsonb NOT NULL DEFAULT '{}'::jsonb,
  geo jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_status text NOT NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_visit_events_area_check
    CHECK (area IN ('admin', 'public', 'api', 'auth', 'setup', 'unknown')),
  CONSTRAINT awcms_mini_visit_events_human_status_check
    CHECK (human_status IN ('human', 'bot', 'unknown')),
  CONSTRAINT awcms_mini_visit_events_status_code_check
    CHECK (status_code IS NULL OR (status_code >= 100 AND status_code <= 599))
);

CREATE INDEX IF NOT EXISTS awcms_mini_visit_events_tenant_occurred_idx
  ON awcms_mini_visit_events (tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_visit_events_tenant_area_occurred_idx
  ON awcms_mini_visit_events (tenant_id, area, occurred_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_visit_events_tenant_human_status_occurred_idx
  ON awcms_mini_visit_events (tenant_id, human_status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_visit_events_session_occurred_idx
  ON awcms_mini_visit_events (visitor_session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_visit_events_identity_occurred_idx
  ON awcms_mini_visit_events (identity_id, occurred_at DESC);

ALTER TABLE awcms_mini_visit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_visit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_visit_events_tenant_isolation
  ON awcms_mini_visit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- No `deleted_at`/soft delete (see file header) and no separate `id`
-- primary key — `(tenant_id, date, area)` is both the natural key and
-- the upsert target for the rollup job (#624), so it is the PRIMARY KEY
-- directly (Postgres creates its backing unique index automatically —
-- the issue's suggested `CREATE INDEX ... (tenant_id, date, area)` would
-- be a redundant duplicate of that index, so it is intentionally not
-- created separately here).
CREATE TABLE IF NOT EXISTS awcms_mini_visitor_daily_rollups (
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  date date NOT NULL,
  area text NOT NULL,
  human_unique_visitors integer NOT NULL DEFAULT 0,
  human_pageviews integer NOT NULL DEFAULT 0,
  bot_pageviews integer NOT NULL DEFAULT 0,
  authenticated_unique_users integer NOT NULL DEFAULT 0,
  public_unique_visitors integer NOT NULL DEFAULT 0,
  admin_unique_users integer NOT NULL DEFAULT 0,
  top_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_browsers jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_devices jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_countries jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date, area),
  CONSTRAINT awcms_mini_visitor_daily_rollups_area_check
    CHECK (area IN ('admin', 'public', 'api', 'auth', 'setup', 'unknown'))
);

ALTER TABLE awcms_mini_visitor_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_visitor_daily_rollups FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_visitor_daily_rollups_tenant_isolation
  ON awcms_mini_visitor_daily_rollups
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
