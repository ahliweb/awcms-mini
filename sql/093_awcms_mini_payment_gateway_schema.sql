-- Issue #877 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `payment_gateway` module schema: the SIXTH and LAST control-plane module. It
-- provides a PROVIDER-NEUTRAL capability for hosted checkout/payment sessions,
-- SIGNED inbound webhooks, normalized payment events, refunds/cancellations
-- where supported, retry/DLQ, provider health, and reconciliation. It records
-- ONLY commercial payment STATE + provider REFERENCES — it is emphatically NOT
-- a general ledger / AR-AP subledger / double-entry accounting / merchant
-- settlement / tax engine, and it never stores raw card credentials/PAN
-- (ADR-0022 §11 boundary). A settled/refunded outcome flows back to
-- `subscription_billing` (#876) ONLY through the module's own validated,
-- audited write path (`recordPaymentAllocation`, the `billing_document_state`
-- port seam) — never a provider call inside a billing transaction (ADR-0006).
--
-- ## Placement (ADR-0022 §3) — a tenant-SCOPED control-plane module
--
-- Every row is TENANT-SCOPED: `tenant_id` + `ENABLE` + `FORCE ROW LEVEL
-- SECURITY` + a policy whose predicate is ALWAYS AND ONLY
-- `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022 §6
-- High-1 "no soft super-tenant": NEVER extended with an `OR platform-claim`
-- clause). A platform operator manages a tenant's payment config ONLY inside
-- that target tenant's per-tenant context (`SET LOCAL app.current_tenant_id`,
-- one tenant per context, each command audited). Tenant A never sees/changes
-- tenant B's intents/webhooks. `tenant_id` is first in every composite index
-- (doc 04 §Index standard).
--
-- The `awcms_mini_tenants` REGISTRY row is owned by Core `tenant_admin`; this
-- module references it by FK and NEVER duplicates it. The billing invoice a
-- payment settles is owned by `subscription_billing` (#876); this module stores
-- an `invoice_id` REFERENCE (uuid, NO cross-module FK — the boundary is the
-- `billing_document_state` capability port read at the composition root, never a
-- shared-table write, ADR-0013 §6 / ADR-0022 §4).
--
-- ## Secrets are NEVER stored here (ADR-0022 §3/§6)
--
-- A provider account row stores a `signing_secret_ref` POINTER only — the shape
-- `env:PAYMENT_GATEWAY_<...>` (an environment variable NAME), never the secret
-- VALUE. The verifier/dispatcher resolves the pointer against `process.env` at
-- runtime; the secret never touches a table, event, log, or audit record. A
-- compromised provider credential is a deployment-scope incident (rotate the env
-- var), not a table mutation.
--
-- ## Webhook envelope PII masking (ADR-0022 §8 Medium-2)
--
-- A stored webhook envelope commonly carries raw PII (name, email, billing
-- address). Only a bounded, doc-04-MASKED troubleshooting snippet is persisted
-- for a signature-VALID delivery, never the full raw body — the same data-
-- minimization rule `integration_hub` established (#754). No raw PII/secret ever
-- lands in a table, event, or log.
--
-- ## Money is EXACT minor units (ADR-0022 epic pattern #5)
--
-- Every monetary column is `bigint` minor units (cents/sen) — NEVER float /
-- numeric-with-scale. Amounts are bounded to +/- Number.MAX_SAFE_INTEGER
-- (9007199254740991) at the CHECK layer (mirrored by `domain/money.ts`) so a JS
-- `Number(...)` round-trip is always exact. An intent/refund is SINGLE-CURRENCY.
--
-- ## Immutability / write-once / append-only (ADR-0022 §9, epic pattern #4)
--
-- `payment_gateway` owns these tables; no other module writes them (gated by
-- `tests/unit/module-boundary.test.ts`).
--   - payment_intents: forward-legal payment state machine (ADR-0022 §11.5:
--     initiated -> pending -> {settled, failed, expired}; failed -> initiated
--     (retry); settled -> {refunded, disputed}); `version` is a monotonic
--     optimistic-concurrency counter (+1 per state change). Never hard-deleted.
--   - webhook_inbox / normalized_events / processing_attempts / reconciliations:
--     fully APPEND-ONLY (reject UPDATE + DELETE) — the immutable signed-delivery
--     provenance + anti-replay identity + out-of-order evidence trail.
--   - refunds: forward-legal (requested -> pending -> {succeeded, failed}); the
--     provider RESULT is write-once (frozen once succeeded/failed).
--   - outbox: churny operational dispatch queue (bounded UPDATE for status +
--     backoff; never DELETE — replay/DLQ is a status, not a row destroy).
--   - provider_accounts: bounded config UPDATE (enable/disable/rotate ref);
--     never DELETE (disable, never destroy — evidence trail).
-- No secret is stored here; provider references are opaque ids; reasons are
-- bounded operator free text (ADR-0022 §8).

-- =====================================================================
-- 1. `awcms_mini_payment_gateway_provider_accounts` — the (tenant, provider,
--    account) BINDING. This is the anti-cross-tenant-substitution anchor
--    (ADR-0022 §6/§10): the GLOBAL unique (provider_key, provider_account_ref)
--    guarantees a given provider account maps to EXACTLY ONE tenant, so a signed
--    webhook claiming provider X account Y can never be replayed against another
--    tenant. `signing_secret_ref` is an `env:` POINTER (never the secret value);
--    `endpoint_host` / `callback_host` are the allow-listed provider API host +
--    return-URL host (SSRF/open-redirect host-equality, checked with new URL()
--    host equality, never a startsWith prefix).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_key text NOT NULL,
  -- Opaque merchant/account identifier from the provider (NOT a secret) — the
  -- webhook's claimed account maps to exactly this row (and thus this tenant).
  provider_account_ref text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active',
  -- `env:VAR_NAME` pointer only — the signing secret VALUE lives in process.env,
  -- NEVER in this table (ADR-0022 §3/§6). CHECK enforces the pointer shape.
  signing_secret_ref text NOT NULL,
  -- Allow-listed provider API host (outbound SSRF host-equality) and callback/
  -- return-URL host (open-redirect host-equality). Bare hostnames, lower-case.
  endpoint_host text NOT NULL,
  callback_host text,
  -- Inbound webhook freshness window (seconds) — bounded to <= 300 (ADR-0022 §9).
  webhook_tolerance_seconds integer NOT NULL DEFAULT 300,
  -- Inbound body-size guard (bytes).
  max_webhook_body_bytes integer NOT NULL DEFAULT 65536,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_provider_key_check
    CHECK (provider_key ~ '^[a-z][a-z0-9_]*$' AND length(provider_key) <= 60),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_account_ref_size_check
    CHECK (length(provider_account_ref) BETWEEN 1 AND 200),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_status_check
    CHECK (status IN ('active', 'disabled')),
  -- The pointer shape is `env:VAR_NAME` — never a literal secret. The gate in
  -- `scripts/security-readiness.ts` + the TS resolver both re-check this.
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_secret_ref_check
    CHECK (signing_secret_ref ~ '^env:[A-Z][A-Z0-9_]*$' AND length(signing_secret_ref) <= 200),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_endpoint_host_check
    CHECK (endpoint_host ~ '^[a-z0-9.-]+$' AND length(endpoint_host) BETWEEN 1 AND 255),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_callback_host_check
    CHECK (callback_host IS NULL OR (callback_host ~ '^[a-z0-9.-]+$' AND length(callback_host) BETWEEN 1 AND 255)),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_tolerance_check
    CHECK (webhook_tolerance_seconds BETWEEN 1 AND 300),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_body_bytes_check
    CHECK (max_webhook_body_bytes BETWEEN 256 AND 1048576),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_display_name_size_check
    CHECK (display_name IS NULL OR length(display_name) <= 200),
  CONSTRAINT awcms_mini_payment_gateway_provider_accounts_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000)
);

-- GLOBAL uniqueness (enforced regardless of RLS) — one provider account maps to
-- exactly one tenant: the cross-tenant event-substitution guard (ADR-0022 §6/§10).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_provider_accounts_binding_key
  ON awcms_mini_payment_gateway_provider_accounts (provider_key, provider_account_ref);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_provider_accounts_tenant_idx
  ON awcms_mini_payment_gateway_provider_accounts (tenant_id, provider_key, status);

ALTER TABLE awcms_mini_payment_gateway_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_provider_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_provider_accounts_tenant_isolation
  ON awcms_mini_payment_gateway_provider_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 2. `awcms_mini_payment_gateway_payment_intents` — the payment intent/session
--    state machine (ADR-0022 §11.5). `invoice_id` is a REFERENCE to the billing
--    document (#876) resolved via the `billing_document_state` port — NO
--    cross-module FK. `status` moves only along the forward-legal state machine
--    (trigger-enforced), `version` is the optimistic-concurrency token every
--    write path row-locks (`FOR UPDATE`) then updates with a status+version
--    predicate, so a concurrent/invalid change is a deterministic 409. The
--    partial UNIQUE (invoice_id) WHERE status IN ('initiated','pending')
--    prevents two concurrent live charges for the same invoice (duplicate-billing
--    guard, ADR-0022 §10).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_account_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_provider_accounts (id),
  provider_key text NOT NULL,
  -- Billing document reference (#876) — validated via the billing_document_state
  -- port at the composition root; intentionally NOT a cross-module FK.
  invoice_id uuid NOT NULL,
  subscription_id uuid,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'initiated',
  previous_status text,
  version integer NOT NULL DEFAULT 1,
  -- Opaque provider session/charge reference + hosted checkout URL (NOT secret;
  -- masked in logs/audit). Set once the outbox dispatch succeeds.
  provider_session_ref text,
  checkout_url text,
  -- Monotonic provider event sequence last applied (out-of-order guard).
  last_event_sequence bigint NOT NULL DEFAULT 0,
  failure_class text,
  reason text,
  correlation_id text,
  actor uuid,
  expires_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_provider_key_check
    CHECK (provider_key ~ '^[a-z][a-z0-9_]*$' AND length(provider_key) <= 60),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_amount_range_check
    CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_status_check
    CHECK (status IN ('initiated', 'pending', 'settled', 'failed', 'expired', 'refunded', 'disputed')),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_previous_status_check
    CHECK (previous_status IS NULL OR previous_status IN ('initiated', 'pending', 'settled', 'failed', 'expired', 'refunded', 'disputed')),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_sequence_check
    CHECK (last_event_sequence >= 0),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_session_ref_size_check
    CHECK (provider_session_ref IS NULL OR length(provider_session_ref) <= 200),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_checkout_url_size_check
    CHECK (checkout_url IS NULL OR length(checkout_url) <= 2000),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_failure_class_size_check
    CHECK (failure_class IS NULL OR length(failure_class) <= 100),
  CONSTRAINT awcms_mini_payment_gateway_payment_intents_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000)
);

-- Duplicate-billing guard: at most one LIVE (initiated/pending) intent per invoice.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_payment_intents_live_invoice_key
  ON awcms_mini_payment_gateway_payment_intents (tenant_id, invoice_id)
  WHERE status IN ('initiated', 'pending');

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_payment_intents_tenant_status_idx
  ON awcms_mini_payment_gateway_payment_intents (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_payment_intents_tenant_invoice_idx
  ON awcms_mini_payment_gateway_payment_intents (tenant_id, invoice_id, created_at DESC);

-- Provider session lookup (webhook -> intent) is per (account, session_ref).
CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_payment_intents_session_idx
  ON awcms_mini_payment_gateway_payment_intents (tenant_id, provider_account_id, provider_session_ref)
  WHERE provider_session_ref IS NOT NULL;

ALTER TABLE awcms_mini_payment_gateway_payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_payment_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_payment_intents_tenant_isolation
  ON awcms_mini_payment_gateway_payment_intents
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 3. `awcms_mini_payment_gateway_webhook_inbox` — APPEND-ONLY signed inbound
--    webhook envelope inbox. The DURABLE anti-replay identity is the UNIQUE
--    (tenant_id, provider_account_id, provider_event_id) — a persistent DB
--    constraint (NOT an in-memory cache, ADR-0022 §9), so a replayed/duplicated
--    delivery is caught after a process restart / across replicas. A verified
--    delivery updates payment EXACTLY ONCE (the loser of the ON CONFLICT is a
--    clean no-op). Signature/timestamp/binding/size/ordering failures persist a
--    REJECTED row (fresh per-attempt replay id) with a safe reason — never the
--    raw body/secret; only a doc-04-MASKED snippet is stored, valid delivery only.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_account_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_provider_accounts (id),
  provider_key text NOT NULL,
  -- The provider's own event id/nonce — the anti-replay identity. For a REJECTED
  -- attempt (no trustworthy id) a fresh random uuid is used so a flood of invalid
  -- attempts never collides with (or blocks) a legitimate delivery.
  provider_event_id text NOT NULL,
  signature_valid boolean NOT NULL,
  verification_failure_reason text,
  event_timestamp_seconds bigint,
  content_type text,
  raw_body_sha256 text NOT NULL,
  raw_body_size integer NOT NULL,
  -- doc-04-MASKED troubleshooting snippet (signature-VALID delivery only); never
  -- the full raw body, never raw PII/secret.
  masked_snippet text,
  status text NOT NULL DEFAULT 'received',
  normalized_event_id uuid,
  correlation_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_payment_gateway_webhook_inbox_status_check
    CHECK (status IN ('received', 'normalized', 'rejected')),
  CONSTRAINT awcms_mini_payment_gateway_webhook_inbox_reason_size_check
    CHECK (verification_failure_reason IS NULL OR length(verification_failure_reason) <= 100),
  CONSTRAINT awcms_mini_payment_gateway_webhook_inbox_event_id_size_check
    CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  CONSTRAINT awcms_mini_payment_gateway_webhook_inbox_body_size_check
    CHECK (raw_body_size >= 0),
  CONSTRAINT awcms_mini_payment_gateway_webhook_inbox_snippet_size_check
    CHECK (masked_snippet IS NULL OR length(masked_snippet) <= 2000)
);

-- DURABLE anti-replay / exactly-once identity.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_webhook_inbox_replay_key
  ON awcms_mini_payment_gateway_webhook_inbox (tenant_id, provider_account_id, provider_event_id);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_webhook_inbox_tenant_status_idx
  ON awcms_mini_payment_gateway_webhook_inbox (tenant_id, status, received_at DESC);

ALTER TABLE awcms_mini_payment_gateway_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_webhook_inbox FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_webhook_inbox_tenant_isolation
  ON awcms_mini_payment_gateway_webhook_inbox
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 4. `awcms_mini_payment_gateway_normalized_events` — APPEND-ONLY normalized
--    provider events (the neutral vocabulary: settled/failed/expired/refunded/
--    disputed). One per verified inbound delivery. `provider_sequence` is the
--    monotonic ordering signal used to reject out-of-order regressions safely.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_normalized_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  webhook_inbox_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_webhook_inbox (id),
  intent_id uuid REFERENCES awcms_mini_payment_gateway_payment_intents (id),
  provider_key text NOT NULL,
  provider_session_ref text,
  normalized_status text NOT NULL,
  provider_status_raw text,
  provider_sequence bigint NOT NULL DEFAULT 0,
  currency text,
  amount_minor bigint,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_payment_gateway_normalized_events_status_check
    CHECK (normalized_status IN ('settled', 'failed', 'expired', 'refunded', 'disputed', 'pending', 'unknown')),
  CONSTRAINT awcms_mini_payment_gateway_normalized_events_sequence_check
    CHECK (provider_sequence >= 0),
  CONSTRAINT awcms_mini_payment_gateway_normalized_events_currency_check
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_payment_gateway_normalized_events_amount_range_check
    CHECK (amount_minor IS NULL OR amount_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT awcms_mini_payment_gateway_normalized_events_raw_size_check
    CHECK (provider_status_raw IS NULL OR length(provider_status_raw) <= 100)
);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_normalized_events_tenant_intent_idx
  ON awcms_mini_payment_gateway_normalized_events (tenant_id, intent_id, provider_sequence DESC);

ALTER TABLE awcms_mini_payment_gateway_normalized_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_normalized_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_normalized_events_tenant_isolation
  ON awcms_mini_payment_gateway_normalized_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 5. `awcms_mini_payment_gateway_processing_attempts` — APPEND-ONLY record of
--    each attempt to apply a normalized event onto an intent. Captures the
--    idempotent/out-of-order decision (applied / ignored_out_of_order /
--    ignored_duplicate / ignored_terminal) with from/to status — the evidence
--    trail for deterministic safe state (ADR-0022 §9 AC "out-of-order events
--    produce deterministic safe state and reconciliation evidence").
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_processing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  normalized_event_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_normalized_events (id),
  intent_id uuid REFERENCES awcms_mini_payment_gateway_payment_intents (id),
  outcome text NOT NULL,
  from_status text,
  to_status text,
  detail text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_payment_gateway_processing_attempts_outcome_check
    CHECK (outcome IN ('applied', 'ignored_out_of_order', 'ignored_duplicate', 'ignored_terminal', 'ignored_unknown_intent')),
  CONSTRAINT awcms_mini_payment_gateway_processing_attempts_detail_size_check
    CHECK (detail IS NULL OR length(detail) <= 500)
);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_processing_attempts_tenant_intent_idx
  ON awcms_mini_payment_gateway_processing_attempts (tenant_id, intent_id, created_at DESC);

ALTER TABLE awcms_mini_payment_gateway_processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_processing_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_processing_attempts_tenant_isolation
  ON awcms_mini_payment_gateway_processing_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 6. `awcms_mini_payment_gateway_outbox` — provider-work dispatch queue. The
--    LOCAL row is committed FIRST (in the source tx); a worker dispatches the
--    provider call OUTSIDE any DB transaction (ADR-0006), then records the
--    outcome. Bounded retry/backoff (attempts + next_attempt_at); a row that
--    exhausts max attempts moves to `dead` (DLQ, manual retry). `payload` is
--    doc-04-masked and carries NO secret. Leased-claim by the dispatch worker.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_account_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_provider_accounts (id),
  intent_id uuid REFERENCES awcms_mini_payment_gateway_payment_intents (id),
  refund_id uuid,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_at timestamptz,
  last_error_class text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_payment_gateway_outbox_kind_check
    CHECK (kind IN ('create_checkout', 'request_refund', 'query_status', 'cancel_session')),
  CONSTRAINT awcms_mini_payment_gateway_outbox_status_check
    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'dead')),
  CONSTRAINT awcms_mini_payment_gateway_outbox_attempts_check
    CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT awcms_mini_payment_gateway_outbox_max_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 50),
  CONSTRAINT awcms_mini_payment_gateway_outbox_claimed_by_size_check
    CHECK (claimed_by IS NULL OR length(claimed_by) <= 200),
  CONSTRAINT awcms_mini_payment_gateway_outbox_error_class_size_check
    CHECK (last_error_class IS NULL OR length(last_error_class) <= 100),
  CONSTRAINT awcms_mini_payment_gateway_outbox_payload_size_check
    CHECK (length(payload::text) <= 8000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_outbox_due_idx
  ON awcms_mini_payment_gateway_outbox (tenant_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_outbox_tenant_status_idx
  ON awcms_mini_payment_gateway_outbox (tenant_id, status, created_at DESC);

ALTER TABLE awcms_mini_payment_gateway_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_outbox_tenant_isolation
  ON awcms_mini_payment_gateway_outbox
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 7. `awcms_mini_payment_gateway_refunds` — refund requests + write-once
--    results. Forward-legal (requested -> pending -> {succeeded, failed}); the
--    provider RESULT (succeeded/failed) is FROZEN by trigger once set. Requires
--    a mandatory reason (ADR-0022 §8) + dedicated permission + idempotency at the
--    application layer. `amount_minor` is EXACT bigint minor units.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  intent_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_payment_intents (id),
  invoice_id uuid,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  previous_status text,
  version integer NOT NULL DEFAULT 1,
  provider_refund_ref text,
  result_class text,
  reason text NOT NULL,
  correlation_id text,
  requested_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_payment_gateway_refunds_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_payment_gateway_refunds_amount_range_check
    CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  CONSTRAINT awcms_mini_payment_gateway_refunds_status_check
    CHECK (status IN ('requested', 'pending', 'succeeded', 'failed')),
  CONSTRAINT awcms_mini_payment_gateway_refunds_previous_status_check
    CHECK (previous_status IS NULL OR previous_status IN ('requested', 'pending', 'succeeded', 'failed')),
  CONSTRAINT awcms_mini_payment_gateway_refunds_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_payment_gateway_refunds_reason_size_check
    CHECK (length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT awcms_mini_payment_gateway_refunds_provider_ref_size_check
    CHECK (provider_refund_ref IS NULL OR length(provider_refund_ref) <= 200),
  CONSTRAINT awcms_mini_payment_gateway_refunds_result_class_size_check
    CHECK (result_class IS NULL OR length(result_class) <= 100)
);

-- Idempotent per (intent, provider_refund_ref): a replayed provider refund
-- outcome is recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_refunds_provider_ref_key
  ON awcms_mini_payment_gateway_refunds (intent_id, provider_refund_ref)
  WHERE provider_refund_ref IS NOT NULL;

-- Cumulative over-refund guard (money integrity, ADR-0022 §10): AT MOST ONE LIVE
-- (requested/pending) refund per intent. Without it, two refund requests for the
-- same settled intent — each individually within the captured amount — would both
-- reach `requested` and both dispatch to the provider (double refund / money
-- loss), because the intent stays `settled` until the FIRST refund RESOLVES and a
-- `FOR UPDATE` on the intent alone does not serialize distinct refund rows. This
-- partial UNIQUE makes the second concurrent request a clean `ON CONFLICT DO
-- NOTHING` no-op (mapped to 409), while the application-layer cumulative SUM guard
-- (`requestRefund`) rejects an over-amount BEFORE the insert. Legitimate PARTIAL
-- refunds remain possible sequentially (each earlier one reaches a terminal state
-- before the next), and the SUM guard bounds their total to the captured amount.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_refunds_live_intent_key
  ON awcms_mini_payment_gateway_refunds (tenant_id, intent_id)
  WHERE status IN ('requested', 'pending');

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_refunds_tenant_intent_idx
  ON awcms_mini_payment_gateway_refunds (tenant_id, intent_id, created_at DESC);

ALTER TABLE awcms_mini_payment_gateway_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_refunds FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_refunds_tenant_isolation
  ON awcms_mini_payment_gateway_refunds
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 8. `awcms_mini_payment_gateway_reconciliations` — APPEND-ONLY reconciliation
--    evidence. The periodic reconciler compares provider status vs local status
--    and records match / mismatch_resolved / mismatch_flagged — the source of
--    truth beyond a single webhook (provider-outage-safe, ADR-0022 §9).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  intent_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_payment_intents (id),
  provider_status text,
  local_status text NOT NULL,
  outcome text NOT NULL,
  detail text,
  correlation_id text,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_payment_gateway_reconciliations_outcome_check
    CHECK (outcome IN ('match', 'mismatch_resolved', 'mismatch_flagged', 'provider_unavailable')),
  CONSTRAINT awcms_mini_payment_gateway_reconciliations_provider_status_size_check
    CHECK (provider_status IS NULL OR length(provider_status) <= 100),
  CONSTRAINT awcms_mini_payment_gateway_reconciliations_local_status_size_check
    CHECK (length(local_status) <= 100),
  CONSTRAINT awcms_mini_payment_gateway_reconciliations_detail_size_check
    CHECK (detail IS NULL OR length(detail) <= 500)
);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_reconciliations_tenant_intent_idx
  ON awcms_mini_payment_gateway_reconciliations (tenant_id, intent_id, reconciled_at DESC);

ALTER TABLE awcms_mini_payment_gateway_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_reconciliations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_reconciliations_tenant_isolation
  ON awcms_mini_payment_gateway_reconciliations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 9. `awcms_mini_payment_gateway_provider_health` — provider adapter health +
--    circuit breaker state (up/degraded/down + circuit_open_until). Upserted
--    after each outbound dispatch/inbound verification. Operational (mutable).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_provider_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_account_id uuid NOT NULL REFERENCES awcms_mini_payment_gateway_provider_accounts (id),
  direction text NOT NULL,
  state text NOT NULL DEFAULT 'up',
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  circuit_open_until timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_payment_gateway_provider_health_direction_check
    CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT awcms_mini_payment_gateway_provider_health_state_check
    CHECK (state IN ('up', 'degraded', 'down')),
  CONSTRAINT awcms_mini_payment_gateway_provider_health_failures_check
    CHECK (consecutive_failures >= 0),
  CONSTRAINT awcms_mini_payment_gateway_provider_health_successes_check
    CHECK (consecutive_successes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_provider_health_key
  ON awcms_mini_payment_gateway_provider_health (tenant_id, provider_account_id, direction);

ALTER TABLE awcms_mini_payment_gateway_provider_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_provider_health FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_provider_health_tenant_isolation
  ON awcms_mini_payment_gateway_provider_health
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 10. `awcms_mini_payment_gateway_job_leases` — per-(tenant, job_kind)
--     cooperative lease for the scheduled dispatch/retry/reconcile workers
--     (pattern #872). A worker claims by UPDATE ... WHERE the lease is free or
--     expired, RETURNING; a heartbeat extends it; release clears the holder. A
--     crashed worker's lease expires so another worker safely resumes. Bounded,
--     DB-only, offline-safe.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_payment_gateway_job_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  job_kind text NOT NULL,
  holder text,
  leased_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_payment_gateway_job_leases_kind_check
    CHECK (job_kind IN ('outbox_dispatch', 'reconcile', 'expire_sweep')),
  CONSTRAINT awcms_mini_payment_gateway_job_leases_holder_size_check
    CHECK (holder IS NULL OR length(holder) <= 200),
  CONSTRAINT awcms_mini_payment_gateway_job_leases_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT awcms_mini_payment_gateway_job_leases_last_error_size_check
    CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_payment_gateway_job_leases_key
  ON awcms_mini_payment_gateway_job_leases (tenant_id, job_kind);

ALTER TABLE awcms_mini_payment_gateway_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_payment_gateway_job_leases FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_payment_gateway_job_leases_tenant_isolation
  ON awcms_mini_payment_gateway_job_leases
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- SECURITY DEFINER bootstrap lookup — the inbound webhook receiver
-- (`POST /api/v1/payment-gateway/webhook/{providerAccountId}`) has no prior
-- tenant JWT; it must resolve (tenant_id, account metadata) from an opaque
-- `provider_account_id` BEFORE any `withTenant(...)` transaction can run (RLS
-- requires `app.current_tenant_id` to already be set). Mirrors
-- `awcms_mini_resolve_integration_endpoint_lookup` (migration 073) exactly:
-- fixed static SQL (no dynamic SQL), a narrow NON-SECRET projection (returns the
-- `signing_secret_ref` env: POINTER, never the secret VALUE), joins the RLS-free
-- `awcms_mini_tenants` row in the SAME call so it costs exactly one round trip
-- for every outcome (no timing side-channel between "unknown account" and "known
-- account, inactive tenant"). EXECUTE restricted to `awcms_mini_app`.
-- =====================================================================
CREATE OR REPLACE FUNCTION awcms_mini_resolve_payment_gateway_account_lookup(
  p_account_id uuid
)
RETURNS TABLE (
  provider_account_id uuid,
  tenant_id uuid,
  provider_key text,
  provider_account_ref text,
  account_status text,
  signing_secret_ref text,
  endpoint_host text,
  callback_host text,
  webhook_tolerance_seconds integer,
  max_webhook_body_bytes integer,
  tenant_status text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT
    a.id,
    a.tenant_id,
    a.provider_key,
    a.provider_account_ref,
    a.status,
    a.signing_secret_ref,
    a.endpoint_host,
    a.callback_host,
    a.webhook_tolerance_seconds,
    a.max_webhook_body_bytes,
    t.status
  FROM awcms_mini_payment_gateway_provider_accounts AS a
  JOIN awcms_mini_tenants AS t ON t.id = a.tenant_id
  WHERE a.id = p_account_id
$function$;

COMMENT ON FUNCTION awcms_mini_resolve_payment_gateway_account_lookup(uuid) IS
  'Issue #877: narrow SECURITY DEFINER bootstrap read for provider_account_id -> tenant/account lookup before tenant context exists (inbound webhook receiver has no prior tenant JWT). Joins the RLS-free awcms_mini_tenants row in the same call to avoid a timing side-channel between "unknown account" and "known account, inactive tenant". Returns only non-secret metadata plus signing_secret_ref (an env: pointer, never the secret value itself). EXECUTE restricted to awcms_mini_app.';

REVOKE ALL ON FUNCTION awcms_mini_resolve_payment_gateway_account_lookup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION awcms_mini_resolve_payment_gateway_account_lookup(uuid) TO awcms_mini_app;

-- =====================================================================
-- Immutability / write-once / append-only triggers
-- (defence in depth beneath the application-layer guards)
-- =====================================================================

-- Shared: forbid any hard DELETE.
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_gateway: % rows are never hard-deleted (disable/void/state-change, never delete)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Shared: fully append-only (reject UPDATE and DELETE).
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_gateway: % is append-only (no UPDATE/DELETE)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Payment intents: identity + amount frozen; forward-legal state machine
-- (whitelist mirrors domain/payment-state.ts); version +1 on state change.
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_intent_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    RAISE EXCEPTION 'payment_gateway: intent % identity (tenant/account/provider/invoice/currency/amount) and created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'initiated' AND NEW.status IN ('pending', 'failed', 'expired'))
      OR (OLD.status = 'pending'   AND NEW.status IN ('settled', 'failed', 'expired'))
      OR (OLD.status = 'failed'    AND NEW.status IN ('initiated'))
      OR (OLD.status = 'settled'   AND NEW.status IN ('refunded', 'disputed'))
    ) THEN
      RAISE EXCEPTION 'payment_gateway: illegal payment intent status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'payment_gateway: intent % version must advance by exactly one on a transition (% -> %)', OLD.id, OLD.version, NEW.version
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.previous_status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'payment_gateway: intent % previous_status must equal the prior status on a transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'payment_gateway: intent % version may only change on a status transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Refunds: identity frozen; forward-legal; the RESULT (succeeded/failed) is
-- write-once (a terminal refund can never be re-opened or re-decided).
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_refund_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    RAISE EXCEPTION 'payment_gateway: refund % identity (tenant/intent/currency/amount) and created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'payment_gateway: refund % result is write-once (terminal status % is frozen)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'requested' AND NEW.status IN ('pending', 'failed'))
      OR (OLD.status = 'pending'   AND NEW.status IN ('succeeded', 'failed'))
    ) THEN
      RAISE EXCEPTION 'payment_gateway: illegal refund status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'payment_gateway: refund % version must advance by exactly one on a transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Provider accounts: identity (tenant/provider/account_ref) frozen; created_at
-- frozen (config UPDATE for status/secret-ref/hosts/tolerance is allowed).
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_account_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.provider_account_ref IS DISTINCT FROM OLD.provider_account_ref THEN
    RAISE EXCEPTION 'payment_gateway: provider account % identity (tenant/provider/account_ref) and created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_payment_gateway_provider_accounts_immutability
  BEFORE UPDATE ON awcms_mini_payment_gateway_provider_accounts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_account_immutability();

CREATE TRIGGER awcms_mini_payment_gateway_provider_accounts_no_delete
  BEFORE DELETE ON awcms_mini_payment_gateway_provider_accounts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_no_delete();

CREATE TRIGGER awcms_mini_payment_gateway_payment_intents_immutability
  BEFORE UPDATE ON awcms_mini_payment_gateway_payment_intents
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_intent_immutability();

CREATE TRIGGER awcms_mini_payment_gateway_payment_intents_no_delete
  BEFORE DELETE ON awcms_mini_payment_gateway_payment_intents
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_no_delete();

CREATE TRIGGER awcms_mini_payment_gateway_refunds_immutability
  BEFORE UPDATE ON awcms_mini_payment_gateway_refunds
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_refund_immutability();

CREATE TRIGGER awcms_mini_payment_gateway_refunds_no_delete
  BEFORE DELETE ON awcms_mini_payment_gateway_refunds
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_no_delete();

-- The webhook inbox is APPEND-ONLY for its provenance, but a verified delivery
-- advances `received -> normalized` and sets `normalized_event_id` in the SAME
-- commit. That single forward status update is the ONLY permitted UPDATE.
CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_webhook_inbox_forward()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_gateway: webhook inbox is append-only (no DELETE)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Only a received -> normalized advance (attaching the normalized event id) is
  -- allowed; every other column, and any other status change, is frozen.
  IF NOT (OLD.status = 'received' AND NEW.status = 'normalized')
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid
     OR NEW.raw_body_sha256 IS DISTINCT FROM OLD.raw_body_sha256
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'payment_gateway: webhook inbox row % is append-only except a single received->normalized advance', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_payment_gateway_webhook_inbox_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_payment_gateway_webhook_inbox
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_webhook_inbox_forward();

CREATE TRIGGER awcms_mini_payment_gateway_normalized_events_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_payment_gateway_normalized_events
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_append_only();

CREATE TRIGGER awcms_mini_payment_gateway_processing_attempts_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_payment_gateway_processing_attempts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_append_only();

CREATE TRIGGER awcms_mini_payment_gateway_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_payment_gateway_reconciliations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_append_only();

CREATE TRIGGER awcms_mini_payment_gateway_outbox_no_delete
  BEFORE DELETE ON awcms_mini_payment_gateway_outbox
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_no_delete();

-- =====================================================================
-- Least-privilege grants for the runtime app + worker roles (ADR-0022 §12)
-- =====================================================================
--
-- `awcms_mini_app` auto-inherits SELECT/INSERT/UPDATE/DELETE on every new table
-- (migration 013's `ALTER DEFAULT PRIVILEGES`). Narrow to real access:
--   - provider_accounts/payment_intents/refunds : never hard-deleted -> REVOKE DELETE.
--   - webhook_inbox/normalized_events/processing_attempts/reconciliations : append-only -> REVOKE UPDATE (inbox keeps a guarded UPDATE for received->normalized) + DELETE.
--   - outbox : churny operational (status/backoff UPDATE) -> keep UPDATE, REVOKE DELETE.
--   - provider_health/job_leases : churny operational -> keep full (bounded by RLS).
REVOKE DELETE ON awcms_mini_payment_gateway_provider_accounts FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_payment_intents FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_refunds FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_payment_gateway_normalized_events FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_payment_gateway_processing_attempts FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_payment_gateway_reconciliations FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_webhook_inbox FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_outbox FROM awcms_mini_app;

-- `awcms_mini_worker` least-privilege role (migration 013/045) — the outbox
-- dispatch / reconcile / expire-sweep jobs run as this role. It needs explicit
-- per-table grants (ALTER DEFAULT PRIVILEGES only grants `awcms_mini_app`):
--   - provider_accounts : SELECT (dispatch reads host/secret-ref/tolerance).
--   - payment_intents : SELECT + UPDATE (advance status from reconcile).
--   - outbox : SELECT + UPDATE (claim/finalize dispatch status transitions).
--   - normalized_events/processing_attempts/reconciliations : INSERT + SELECT.
--   - provider_health : SELECT + INSERT + UPDATE (health upsert).
--   - job_leases : SELECT + INSERT + UPDATE (cooperative lease).
--   - refunds : SELECT + UPDATE (dispatch records provider refund result).
GRANT SELECT ON awcms_mini_payment_gateway_provider_accounts TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_payment_gateway_payment_intents TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_payment_gateway_outbox TO awcms_mini_worker;
GRANT SELECT, INSERT ON awcms_mini_payment_gateway_normalized_events TO awcms_mini_worker;
GRANT SELECT, INSERT ON awcms_mini_payment_gateway_processing_attempts TO awcms_mini_worker;
GRANT SELECT, INSERT ON awcms_mini_payment_gateway_reconciliations TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_payment_gateway_provider_health TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_payment_gateway_job_leases TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_payment_gateway_refunds TO awcms_mini_worker;
