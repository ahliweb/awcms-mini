-- Issue #643 (epic `social_publishing` #643-#647) — provider-neutral social
-- auto-posting outbox and connector foundation. Full-online-only feature
-- (deployment gate is env-only, see `social-publishing/domain/
-- social-publishing-config.ts`'s `SOCIAL_PUBLISHING_ENABLED`/
-- `SOCIAL_PUBLISHING_PROFILE`, mirroring `AUTH_ONLINE_SECURITY_ENABLED`/
-- `AUTH_ONLINE_SECURITY_PROFILE`'s established pattern — see
-- `src/lib/auth/online-security-config.ts`) — this migration itself has no
-- env dependency, it only creates the schema every deployment profile can
-- have present but inert.
--
-- Six tables, one more than the issue body's literal "Core entities" list of
-- five (`awcms_mini_social_accounts`, `..._social_publish_rules`,
-- `..._social_publish_jobs`, `..._social_publish_attempts`,
-- `..._social_publish_templates`). The sixth,
-- `awcms_mini_social_publishing_settings`, exists to satisfy the issue's own
-- "Required behavior" bullet "Auto-posting can be disabled globally and per
-- tenant" — global is the env gate above; per-tenant needs a real per-tenant
-- switch distinct from disabling every rule/account individually. Unlike
-- Issue #636's tenant-state table, this one IS meant to be tenant-writable
-- (it is an ordinary tenant preference, not a security-enforcement signal a
-- tenant must never defeat) — gated by the ordinary `rules.configure`
-- permission via a real ABAC-checked endpoint, not the generic
-- `module_settings` PATCH surface that Issue #636 found exploitable for a
-- security-relevant flag. See `.claude/skills/awcms-mini-social-publishing/
-- SKILL.md` for the full reasoning.
--
-- `token_reference` (both here and per the issue's own "Supported provider
-- model" field list) is a REFERENCE into external secret storage — an
-- opaque string a real secret manager mints (or, until one is integrated, an
-- operator-assigned identifier resolved via environment variables named
-- after it) — NEVER the raw OAuth access/refresh token. See
-- `social-account-validation.ts`'s `looksLikeRawSecretToken` for the
-- best-effort write-time heuristic that rejects values shaped like real
-- bearer tokens/JWTs pasted in by mistake, and
-- `social-account-directory.ts`'s header comment for why no query in this
-- module ever selects `token_reference` back out (same "write-only,
-- deliberately never selected" precedent `tenant-domain-directory.ts` set
-- for `verification_token_hash`).
--
-- `provider_key` is intentionally NOT a fixed enum (unlike, say,
-- `..._ad_placements.placement_key`) — this issue is a provider-neutral
-- FOUNDATION; the concrete provider keys (`facebook_page`,
-- `instagram_business`, `linkedin_organization`, `telegram_channel`, ...)
-- are minted by the adapter issues (#644 Meta, #645 LinkedIn, #646
-- Telegram) via `social-provider-registry.ts`, not by a migration-owned
-- CHECK list that would need editing for every future adapter. A `CHECK` on
-- FORMAT (lowercase snake_case, bounded length) still applies, matching the
-- write-time validator in `social-account-validation.ts`.
CREATE TABLE IF NOT EXISTS awcms_mini_social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_key text NOT NULL,
  provider_account_id text NOT NULL,
  provider_account_name text NOT NULL,
  provider_account_type text NOT NULL,
  connection_status text NOT NULL DEFAULT 'pending',
  token_reference text,
  scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  last_verified_at timestamptz,
  auto_publish_enabled boolean NOT NULL DEFAULT false,
  connected_by uuid,
  connected_at timestamptz,
  disconnected_by uuid,
  disconnected_at timestamptz,
  disconnect_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_social_accounts_provider_key_format_check
    CHECK (provider_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  CONSTRAINT awcms_mini_social_accounts_account_type_check
    CHECK (provider_account_type IN ('page', 'profile', 'channel', 'group', 'organization')),
  CONSTRAINT awcms_mini_social_accounts_connection_status_check
    CHECK (connection_status IN ('pending', 'connected', 'disconnected', 'needs_reauth', 'error'))
);

-- One row per (tenant, provider, external account) — the natural identity
-- that makes `connect` idempotent (reconnecting/reauthorizing an already-
-- known account upserts this row rather than creating a duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_social_accounts_identity_key
  ON awcms_mini_social_accounts (tenant_id, provider_key, provider_account_id);

CREATE INDEX IF NOT EXISTS awcms_mini_social_accounts_tenant_status_idx
  ON awcms_mini_social_accounts (tenant_id, connection_status);

ALTER TABLE awcms_mini_social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_social_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_social_accounts_tenant_isolation
  ON awcms_mini_social_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- One rule per (account, trigger event) — "Rules can trigger on post
-- published, scheduled published, or manual editor action" (issue body).
-- `requires_approval` defaults `true` (safe default: an operator must
-- explicitly opt an account/trigger combination INTO unattended posting,
-- matching this repo's "opt-in, default off" convention for anything that
-- reaches an external provider).
CREATE TABLE IF NOT EXISTS awcms_mini_social_publish_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  social_account_id uuid NOT NULL REFERENCES awcms_mini_social_accounts (id),
  trigger_event text NOT NULL,
  requires_approval boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  template_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_social_publish_rules_trigger_event_check
    CHECK (trigger_event IN ('post_published', 'scheduled_published', 'manual_editor_action'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_social_publish_rules_identity_key
  ON awcms_mini_social_publish_rules (tenant_id, social_account_id, trigger_event)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_social_publish_rules_account_id_idx
  ON awcms_mini_social_publish_rules (social_account_id);

ALTER TABLE awcms_mini_social_publish_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_social_publish_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_social_publish_rules_tenant_isolation
  ON awcms_mini_social_publish_rules
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Optional per-tenant caption templates ("template_id" above references
-- this table; no FK constraint from rules -> templates is added here
-- because a rule may reference `NULL` (no template, provider adapter falls
-- back to its own default caption shape) — application-layer validation
-- checks existence/tenant-ownership when a non-null `templateId` is
-- supplied, same "polymorphic reference, no FK, application validates"
-- reasoning `awcms_mini_news_media_objects.owner_resource_id` uses, chosen
-- here to avoid forcing a template to exist before a rule can reference
-- "no template" and to allow a template to be soft-deleted without an FK
-- violation blocking it while rules still point at it (an application-level
-- fallback resolves a soft-deleted template's id back to the default
-- caption shape, never a hard failure at render time).
CREATE TABLE IF NOT EXISTS awcms_mini_social_publish_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_key text,
  name text NOT NULL,
  caption_template text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_social_publish_templates_provider_key_format_check
    CHECK (provider_key IS NULL OR provider_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  CONSTRAINT awcms_mini_social_publish_templates_name_length_check
    CHECK (char_length(name) <= 200),
  CONSTRAINT awcms_mini_social_publish_templates_caption_length_check
    CHECK (char_length(caption_template) <= 2000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_social_publish_templates_tenant_idx
  ON awcms_mini_social_publish_templates (tenant_id)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_social_publish_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_social_publish_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_social_publish_templates_tenant_isolation
  ON awcms_mini_social_publish_templates
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The outbox itself. `article_id` is a REAL foreign key into
-- `awcms_mini_blog_posts` (unlike the polymorphic, FK-less
-- `owner_resource_id` the news media registry uses) — `blog_content` is a
-- base module always present (not an optional dependency the way R2 media
-- is for `news_portal`), and "article" here always means a blog post, never
-- a page/gallery/other resource type, so a real FK gives a stronger
-- guarantee at negligible coupling cost.
--
-- Every content field below (`title`, `excerpt_or_caption`, `canonical_url`,
-- `image_url`) is a SNAPSHOT captured at job-creation time, not a live join
-- back to `awcms_mini_blog_posts` — required by the outbox pattern (ADR-0006):
-- the row must be fully self-contained so the dispatcher (which runs the
-- actual provider call OUTSIDE any DB transaction, per
-- `social-publish-dispatch.ts`) never needs a second read of mutable article
-- state that could have changed (or been deleted) between enqueue and
-- dispatch.
--
-- `provider_key` is DENORMALIZED from the linked `social_account_id` at
-- creation time — lets the dispatcher's CLAIM step filter/skip by provider
-- circuit-breaker state without a join, same reasoning
-- `awcms_mini_object_sync_queue`'s `requires_upload` flag was added for.
--
-- `idempotency_key` + its unique index is THE mechanism behind "Jobs are
-- idempotent per article/platform/account" (issue acceptance criterion) —
-- computed deterministically from
-- `(tenantId, articleId, socialAccountId, action)` by
-- `social-publish-idempotency.ts`'s `buildSocialPublishIdempotencyKey`, so a
-- retriggered publish event (e.g. the scheduled-publish worker re-running
-- after a crash) can never enqueue a second job for the same
-- article/account/action — the `INSERT ... ON CONFLICT DO NOTHING` in
-- `create-social-publish-jobs.ts` relies on this index.
CREATE TABLE IF NOT EXISTS awcms_mini_social_publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  social_account_id uuid NOT NULL REFERENCES awcms_mini_social_accounts (id),
  rule_id uuid REFERENCES awcms_mini_social_publish_rules (id),
  article_id uuid NOT NULL REFERENCES awcms_mini_blog_posts (id),
  provider_key text NOT NULL,
  trigger_event text NOT NULL,
  action text NOT NULL DEFAULT 'publish',
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requires_approval boolean NOT NULL DEFAULT false,
  title text NOT NULL,
  excerpt_or_caption text,
  canonical_url text NOT NULL,
  image_url text,
  approved_by uuid,
  approved_at timestamptz,
  approval_note text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  external_post_id text,
  external_post_url text,
  last_error_code text,
  last_error_message text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_social_publish_jobs_provider_key_format_check
    CHECK (provider_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  CONSTRAINT awcms_mini_social_publish_jobs_trigger_event_check
    CHECK (trigger_event IN ('post_published', 'scheduled_published', 'manual_editor_action')),
  CONSTRAINT awcms_mini_social_publish_jobs_action_check
    CHECK (action IN ('publish')),
  CONSTRAINT awcms_mini_social_publish_jobs_status_check
    CHECK (status IN (
      'pending', 'requires_approval', 'approved', 'scheduled', 'publishing',
      'published', 'failed', 'cancelled', 'skipped', 'rate_limited', 'needs_reauth'
    )),
  CONSTRAINT awcms_mini_social_publish_jobs_attempt_count_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_social_publish_jobs_idempotency_key
  ON awcms_mini_social_publish_jobs (tenant_id, idempotency_key);

-- Dispatcher CLAIM query predicate (`status`, `next_attempt_at`), same
-- convention `awcms_mini_object_sync_queue_retry_idx` uses.
CREATE INDEX IF NOT EXISTS awcms_mini_social_publish_jobs_dispatch_idx
  ON awcms_mini_social_publish_jobs (tenant_id, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS awcms_mini_social_publish_jobs_article_id_idx
  ON awcms_mini_social_publish_jobs (article_id);

CREATE INDEX IF NOT EXISTS awcms_mini_social_publish_jobs_social_account_id_idx
  ON awcms_mini_social_publish_jobs (social_account_id);

CREATE INDEX IF NOT EXISTS awcms_mini_social_publish_jobs_rule_id_idx
  ON awcms_mini_social_publish_jobs (rule_id);

ALTER TABLE awcms_mini_social_publish_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_social_publish_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_social_publish_jobs_tenant_isolation
  ON awcms_mini_social_publish_jobs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only per-attempt audit trail (never UPDATEd/DELETEd by any
-- application code — same "posted"/append-only convention doc 04/10
-- mandate for immutable history rows). One row per dispatcher attempt,
-- whatever the outcome.
CREATE TABLE IF NOT EXISTS awcms_mini_social_publish_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  job_id uuid NOT NULL REFERENCES awcms_mini_social_publish_jobs (id),
  attempt_number integer NOT NULL,
  outcome text NOT NULL,
  error_code text,
  error_message text,
  external_post_id text,
  external_post_url text,
  correlation_id text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_social_publish_attempts_outcome_check
    CHECK (outcome IN ('success', 'failed', 'rate_limited', 'needs_reauth', 'skipped')),
  CONSTRAINT awcms_mini_social_publish_attempts_attempt_number_check
    CHECK (attempt_number >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_social_publish_attempts_job_attempt_key
  ON awcms_mini_social_publish_attempts (job_id, attempt_number);

ALTER TABLE awcms_mini_social_publish_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_social_publish_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_social_publish_attempts_tenant_isolation
  ON awcms_mini_social_publish_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Per-tenant "auto-posting enabled" master switch — see this file's own
-- header comment for why this is a real tenant-writable table (not a
-- security-enforcement signal like Issue #636's tenant state table).
CREATE TABLE IF NOT EXISTS awcms_mini_social_publishing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_mini_tenants (id),
  auto_publishing_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE awcms_mini_social_publishing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_social_publishing_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_social_publishing_settings_tenant_isolation
  ON awcms_mini_social_publishing_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Permission catalog seed — exactly the ten permissions from the issue
-- body's own "Suggested permissions" list, verbatim. Template CRUD reuses
-- `rules.read`/`rules.configure` (no separate `templates.*` permission) —
-- deliberately not inventing new permissions beyond the issue's own
-- suggested list.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('social_publishing', 'accounts', 'read', 'Read connected social publishing accounts'),
  ('social_publishing', 'accounts', 'connect', 'Connect or reconnect/reauthorize a social publishing account'),
  ('social_publishing', 'accounts', 'disconnect', 'Disconnect a social publishing account'),
  ('social_publishing', 'rules', 'read', 'Read social publishing rules and templates'),
  ('social_publishing', 'rules', 'configure', 'Create, update, or delete social publishing rules and templates'),
  ('social_publishing', 'jobs', 'read', 'Read social publishing jobs and their attempts'),
  ('social_publishing', 'jobs', 'approve', 'Approve a social publishing job pending external posting'),
  ('social_publishing', 'jobs', 'cancel', 'Cancel a social publishing job'),
  ('social_publishing', 'jobs', 'retry', 'Retry a failed/rate-limited/needs-reauth social publishing job'),
  ('social_publishing', 'logs', 'read', 'Read social publishing audit/attempt logs')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
