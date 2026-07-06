-- Issue #494 (epic #492, follows architecture Issue #493) — tenant-safe email
-- schema, RLS, and delivery queue.
--
-- Four tables. `email_recipients` from the issue's proposed table list is
-- deliberately NOT created: the issue itself calls it "for recipient-level
-- status when needed", and this design doesn't need it — each
-- `awcms_mini_email_messages` row already IS one recipient's delivery unit
-- (one row = one send attempt to one address), the same "one row per
-- delivery unit" shape `awcms_mini_object_sync_queue` already uses. A bulk
-- announcement (Issue #497) enqueues N `email_messages` rows sharing a
-- `correlation_id`, rather than one message row fanning out to many
-- recipients internally. Revisit only if a future issue needs message-level
-- status distinct from per-recipient status.
--
-- FORCE RLS is applied inline on every tenant-scoped table here (the
-- migration-013-onward convention every table added since then follows —
-- least-privilege `awcms_mini_app`'s default DML grants already cover new
-- tables automatically).
--
-- Sensitive-data handling (doc 04 §Alur perlindungan data sensitif, skill
-- `awcms-mini-sensitive-data`) reused verbatim, not reinvented: recipient
-- addresses are stored as `to_address` (normalized — trimmed+lowercased) +
-- `to_address_hash` (`hashIdentifier`, sha256) + `to_address_masked`
-- (`maskIdentifier`) — see `src/modules/profile-identity/domain/
-- identifier.ts`, reused by the email application layer (Issue #495/#496)
-- rather than a second, divergent normalize/hash/mask implementation.
-- `to_address` itself (not just its hash/mask) has to be retained — a
-- provider adapter cannot deliver an email knowing only a hash — but every
-- diagnostic/log/list surface must read `to_address_masked`, never
-- `to_address` (enforced at the application layer, Issue #495/#499).
--
-- Rendered body is intentionally NOT a column here (no
-- `rendered_html_body`/`rendered_text_body`) — "prefer template key +
-- variables hash over full rendered sensitive body when possible" (issue
-- #494 §Retention and privacy). `template_key` + `variables` (jsonb) are
-- enough for the dispatcher (Issue #495) to render on demand via the
-- template renderer (Issue #498); `variables_hash` (sha256 of the
-- canonicalized JSON) supports idempotency/debugging lookups without
-- reading `variables` itself. Callers (Issue #496's password reset in
-- particular) must not put a long-lived raw secret in `variables` beyond
-- what a single delivery attempt needs — the reset token itself is hashed
-- at rest in its own auth table (Issue #496), never persisted here.
--
-- Retention policy (documented now per issue's "Retention and privacy"
-- section; automated purge job is a fast-follow, not part of this
-- migration): `email_delivery_attempts.provider_response_snippet` is
-- pre-redacted by the caller before insert (never the provider's raw
-- response body); terminal-state `email_messages` rows (sent/failed/
-- cancelled/suppressed) and their `email_delivery_attempts` are candidates
-- for physical purge after a retention window, mirroring
-- `awcms_mini_audit_events`/`AUDIT_LOG_RETENTION_DAYS` (doc 18) — tracked
-- for Issue #499.
CREATE TABLE IF NOT EXISTS awcms_mini_email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  template_key text NOT NULL,
  name text NOT NULL,
  subject_template text NOT NULL,
  text_body_template text,
  html_body_template text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_email_templates_template_key_format_check
    CHECK (template_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT awcms_mini_email_templates_has_body_check
    CHECK (text_body_template IS NOT NULL OR html_body_template IS NOT NULL)
);

-- Business key reusable after soft delete, same partial-unique pattern doc
-- 04 §Soft delete standard prescribes.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_email_templates_tenant_key_idx
  ON awcms_mini_email_templates (tenant_id, template_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_email_templates_tenant_idx
  ON awcms_mini_email_templates (tenant_id)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_email_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_email_templates_tenant_isolation
  ON awcms_mini_email_templates
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  correlation_id text,
  category text NOT NULL,
  template_key text,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'queued',
  to_address text NOT NULL,
  to_address_hash text NOT NULL,
  to_address_masked text NOT NULL,
  subject text NOT NULL,
  variables jsonb,
  variables_hash text,
  provider_name text,
  provider_message_id text,
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT awcms_mini_email_messages_category_format_check
    CHECK (category ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT awcms_mini_email_messages_priority_check
    CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT awcms_mini_email_messages_status_check
    CHECK (status IN (
      'queued', 'sending', 'sent', 'failed', 'retry_wait', 'cancelled',
      'suppressed'
    ))
);

-- Dispatcher polling query shape (Issue #495, mirrors
-- awcms_mini_object_sync_queue_retry_idx, migration 009/017): one tenant at
-- a time, WHERE tenant_id = ? AND status IN ('queued','retry_wait') AND
-- (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY
-- created_at ... FOR UPDATE SKIP LOCKED. `next_attempt_at` doubles as the
-- claim lease expiry while status = 'sending' (no separate lease column),
-- same reuse `object-dispatch.ts` already established.
CREATE INDEX IF NOT EXISTS awcms_mini_email_messages_dispatch_idx
  ON awcms_mini_email_messages (tenant_id, status, next_attempt_at);

-- Admin/diagnostics list view (Issue #499): filter by tenant, optionally by
-- category, newest first.
CREATE INDEX IF NOT EXISTS awcms_mini_email_messages_tenant_category_idx
  ON awcms_mini_email_messages (tenant_id, category, created_at DESC);

-- Suppression-check / "has this address already been sent this category
-- recently" lookups (Issue #496/#497) — never scanned by `to_address`
-- itself.
CREATE INDEX IF NOT EXISTS awcms_mini_email_messages_recipient_hash_idx
  ON awcms_mini_email_messages (tenant_id, to_address_hash);

ALTER TABLE awcms_mini_email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_email_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_email_messages_tenant_isolation
  ON awcms_mini_email_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_email_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  message_id uuid NOT NULL REFERENCES awcms_mini_email_messages (id),
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  provider_name text,
  -- Pre-redacted by the caller (Issue #495) before insert — never the
  -- provider's raw response body. Truncated, not full payload retention.
  provider_response_snippet text,
  error_message text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_email_delivery_attempts_outcome_check
    CHECK (outcome IN ('success', 'failure')),
  CONSTRAINT awcms_mini_email_delivery_attempts_attempt_no_check
    CHECK (attempt_no > 0),
  CONSTRAINT awcms_mini_email_delivery_attempts_unique_attempt
    UNIQUE (message_id, attempt_no)
);

-- "All attempts for this message" (diagnostics detail view) — the FK
-- itself gives this for free via the PK-backed unique constraint above,
-- but an explicit tenant-scoped index also supports the reverse "all
-- attempts for this tenant, newest first" diagnostics query.
CREATE INDEX IF NOT EXISTS awcms_mini_email_delivery_attempts_tenant_idx
  ON awcms_mini_email_delivery_attempts (tenant_id, attempted_at DESC);

ALTER TABLE awcms_mini_email_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_email_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_email_delivery_attempts_tenant_isolation
  ON awcms_mini_email_delivery_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Bounce/complaint/manual block list (issue's optional
-- `email_suppression_list`) — included now (cheap, directly useful for
-- Issue #495's dispatcher and #496's enumeration-safe password reset).
-- `recipient_hash`-only lookup key (no need to retain the raw address once
-- suppressed) with `recipient_masked` kept solely for admin display.
CREATE TABLE IF NOT EXISTS awcms_mini_email_suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  recipient_hash text NOT NULL,
  recipient_masked text NOT NULL,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_email_suppression_list_reason_check
    CHECK (reason IN ('bounced', 'complained', 'manual', 'unsubscribed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_email_suppression_list_tenant_hash_idx
  ON awcms_mini_email_suppression_list (tenant_id, recipient_hash);

ALTER TABLE awcms_mini_email_suppression_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_email_suppression_list FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_email_suppression_list_tenant_isolation
  ON awcms_mini_email_suppression_list
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Permission seeding precedes the endpoints that consume it (same
-- precedent as migration 009's `sync_storage.object_queue.{read,retry}`,
-- which sat unused until the admin ops dashboard endpoints landed later) —
-- RLS already isolates by tenant; these ABAC permissions gate the
-- upcoming admin/diagnostics endpoints (Issue #495/#496/#497/#499).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('email', 'template', 'read', 'Read tenant email templates'),
  ('email', 'template', 'create', 'Create an email template'),
  ('email', 'template', 'update', 'Update an email template'),
  ('email', 'template', 'delete', 'Delete (soft) an email template'),
  ('email', 'message', 'read', 'Read/diagnose tenant email queue'),
  ('email', 'suppression', 'read', 'Read the email suppression list'),
  ('email', 'suppression', 'create', 'Manually suppress a recipient address'),
  ('email', 'suppression', 'delete', 'Remove a manual suppression entry')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
