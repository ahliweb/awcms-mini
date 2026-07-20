-- Issue #876 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `subscription_billing` module schema: the FIFTH control-plane module. It
-- records the commercial SaaS STATE of a tenant's subscription — subscription
-- terms bound to an IMMUTABLE published offer version, billing periods,
-- invoice drafts/issued documents + line items, credit notes, payment
-- allocation REFERENCES, dunning attempts, and scheduled subscription changes
-- (upgrade/downgrade/cancel). It is emphatically NOT a general ledger / AR-AP
-- subledger / double-entry accounting / tax engine / e-invoicing / cash-bank
-- reconciliation / tenant business invoice — billing here is commercial SaaS
-- STATE only (ADR-0013 §3 / ADR-0020 §3 / ADR-0022 §2/§11 boundary). Payment
-- allocation is a REFERENCE (provider ref + amount + which invoice it settles),
-- never an accounting entry or claim.
--
-- ## Placement (ADR-0022 §3) — a tenant-SCOPED control-plane module
--
-- Every row is TENANT-SCOPED: `tenant_id` + `ENABLE` + `FORCE ROW LEVEL
-- SECURITY` + a policy whose predicate is ALWAYS AND ONLY
-- `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022 §6
-- High-1 "no soft super-tenant": NEVER extended with an `OR platform-claim`
-- clause). A platform operator manages a tenant's billing ONLY inside that
-- target tenant's per-tenant context (`SET LOCAL app.current_tenant_id`, one
-- tenant per context, each command audited). Tenant A never sees/changes
-- tenant B's subscription/invoice. `tenant_id` is first in every composite
-- index (doc 04 §Index standard).
--
-- The `awcms_mini_tenants` REGISTRY row is owned by Core `tenant_admin`; this
-- module references it by FK and NEVER duplicates it. Published offers are
-- owned by `service_catalog` (#870); this module stores an IMMUTABLE SNAPSHOT
-- of the offer key/version/hash it bound to, read via the `service_catalog_read`
-- port at the composition root — it never writes catalog tables. Usage lines
-- reconcile to `usage_metering` (#875) aggregates read via the `usage_aggregate`
-- port; the source window/version is recorded on the line. Dunning REQUESTS
-- lifecycle transitions through the #873 `lifecycle_transition` port — it never
-- writes `awcms_mini_tenant_lifecycle_*` directly.
--
-- ## Money is EXACT minor units (ADR-0022 epic pattern #5)
--
-- Every monetary column is `bigint` minor units (e.g. cents/sen) — NEVER float
-- / double / numeric-with-scale rounding. Amounts are bounded to
-- +/- Number.MAX_SAFE_INTEGER (9007199254740991) at the CHECK layer (mirrored
-- by the TS parser) so a JS `Number(...)` round-trip is always exact. An
-- invoice is SINGLE-CURRENCY: the currency lives on the invoice; a line carries
-- no independent currency (mixed-currency totals are structurally impossible).
-- The rounding policy is EXPLICIT and stored per invoice (`rounding_mode`,
-- default `half_up`) so proration/derived amounts are reproducible.
--
-- ## Immutability / write-once / append-only (ADR-0022 §9, epic pattern #4)
--
-- `subscription_billing` owns these tables; no other module writes them (gated
-- by `tests/unit/module-boundary.test.ts`).
--   - subscriptions: offer binding (plan key/version/hash/currency) is FROZEN
--     once set; `state` moves only along the forward-legal state machine;
--     `version` is a monotonic optimistic-concurrency counter (+1 per state
--     change). Never hard-deleted. REVOKE DELETE.
--   - invoices: draft -> issued -> {paid, void}. An ISSUED invoice is IMMUTABLE
--     — amounts/currency/period/subscription/issued provenance are frozen; only
--     the status may advance (issued->paid or issued->void). Correction is a
--     credit note or a void, NEVER an edit/delete. REVOKE DELETE.
--   - invoice_lines: frozen once the parent invoice is issued (BEFORE trigger
--     checks parent status). REVOKE DELETE once issued.
--   - invoice_status_history, credit_notes, payment_allocations,
--     subscription_changes, dunning_attempts: fully APPEND-ONLY (reject
--     UPDATE/DELETE) — the immutable provenance/evidence trail. REVOKE
--     UPDATE + DELETE (dunning/changes keep a bounded UPDATE for their own
--     lifecycle where noted).
-- No secret is stored here — provider references are opaque ids, billing
-- contact is minimized + masked at the application layer (doc 04); reasons are
-- bounded operator free text (ADR-0022 §8).

-- =====================================================================
-- 1. `awcms_mini_subscription_billing_subscriptions` — one subscription record
--    per (tenant, subscription id). Binds IMMUTABLY to a published offer
--    version snapshot (plan key/version/hash + currency frozen). `state` is the
--    subscription state machine (pending/trialing/active/past_due/canceled/
--    expired); `version` is the optimistic-concurrency token every write path
--    row-locks (`FOR UPDATE`) then updates with a state+version predicate, so a
--    concurrent/invalid change is a deterministic 409.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  -- Immutable published-offer binding snapshot (service_catalog #870). Frozen
  -- by trigger once set — a plan CHANGE is a scheduled subscription change +
  -- (optionally) a new subscription, never an in-place rewrite (AC "preserves
  -- historical terms").
  offer_plan_key text NOT NULL,
  offer_version integer NOT NULL,
  offer_hash text NOT NULL,
  currency text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  previous_state text,
  version integer NOT NULL DEFAULT 1,
  -- Billing configuration (reproducible period math).
  billing_interval text NOT NULL DEFAULT 'month',
  billing_anchor_day integer,
  proration_policy text NOT NULL DEFAULT 'daily',
  rounding_mode text NOT NULL DEFAULT 'half_up',
  collection_mode text NOT NULL DEFAULT 'manual',
  -- Lifecycle anchors (informational; the scheduler reads periods/changes).
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  ended_at timestamptz,
  -- Minimized + masked billing contact reference (doc 04) — NEVER a raw email.
  billing_contact_ref text,
  reason text,
  source text NOT NULL DEFAULT 'operator',
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_state_check
    CHECK (state IN ('pending', 'trialing', 'active', 'past_due', 'canceled', 'expired')),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_previous_state_check
    CHECK (previous_state IS NULL OR previous_state IN ('pending', 'trialing', 'active', 'past_due', 'canceled', 'expired')),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_offer_version_check
    CHECK (offer_version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_offer_plan_key_check
    CHECK (offer_plan_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(offer_plan_key) <= 120),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_interval_check
    CHECK (billing_interval IN ('day', 'week', 'month', 'quarter', 'year')),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_anchor_day_check
    CHECK (billing_anchor_day IS NULL OR billing_anchor_day BETWEEN 1 AND 31),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_proration_check
    CHECK (proration_policy IN ('none', 'daily', 'full_period')),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_rounding_check
    CHECK (rounding_mode IN ('half_up', 'half_even', 'floor', 'ceil')),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_collection_check
    CHECK (collection_mode IN ('manual', 'automatic')),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_contact_ref_size_check
    CHECK (billing_contact_ref IS NULL OR length(billing_contact_ref) <= 200),
  CONSTRAINT awcms_mini_subscription_billing_subscriptions_source_check
    CHECK (source IN ('operator', 'system', 'scheduler', 'provisioning', 'lifecycle'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_subscriptions_tenant_state_idx
  ON awcms_mini_subscription_billing_subscriptions (tenant_id, state);

-- At most one NON-terminal subscription per (tenant, plan): prevents two live
-- subscriptions to the same plan racing to generate invoices.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_subscriptions_active_plan_key
  ON awcms_mini_subscription_billing_subscriptions (tenant_id, offer_plan_key)
  WHERE state IN ('pending', 'trialing', 'active', 'past_due');

ALTER TABLE awcms_mini_subscription_billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_subscriptions_tenant_isolation
  ON awcms_mini_subscription_billing_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 2. `awcms_mini_subscription_billing_periods` — the billing periods of a
--    subscription. `sequence` is a monotonic per-subscription counter; the
--    UNIQUE (subscription_id, sequence) is the anchor that makes renewal
--    idempotent (a second worker collides instead of double-creating).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  subscription_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_subscriptions (id),
  sequence integer NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- The immutable offer version this period was priced against (evidence).
  offer_version integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_periods_sequence_check
    CHECK (sequence >= 1),
  CONSTRAINT awcms_mini_subscription_billing_periods_offer_version_check
    CHECK (offer_version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_periods_range_check
    CHECK (period_end > period_start),
  CONSTRAINT awcms_mini_subscription_billing_periods_status_check
    CHECK (status IN ('open', 'invoiced', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_periods_seq_key
  ON awcms_mini_subscription_billing_periods (subscription_id, sequence);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_periods_tenant_sub_idx
  ON awcms_mini_subscription_billing_periods (tenant_id, subscription_id, sequence DESC);

ALTER TABLE awcms_mini_subscription_billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_periods FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_periods_tenant_isolation
  ON awcms_mini_subscription_billing_periods
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 3. `awcms_mini_subscription_billing_invoices` — invoice documents. draft ->
--    issued -> {paid, void}. Money is bigint minor units, single-currency.
--    IDEMPOTENT GENERATION: the partial UNIQUE (subscription_id, period_id)
--    WHERE status <> 'void' guarantees AT MOST ONE live invoice per period
--    under concurrent renewal workers (INSERT ... ON CONFLICT DO NOTHING, the
--    loser replays the winner). An ISSUED invoice is IMMUTABLE (trigger).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  subscription_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_subscriptions (id),
  period_id uuid REFERENCES awcms_mini_subscription_billing_periods (id),
  -- The offer version the invoice was generated from (idempotency dimension +
  -- evidence).
  offer_version integer NOT NULL,
  invoice_number text,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  rounding_mode text NOT NULL DEFAULT 'half_up',
  subtotal_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  credited_minor bigint NOT NULL DEFAULT 0,
  allocated_minor bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  issued_at timestamptz,
  issued_by uuid,
  due_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  billing_contact_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_invoices_status_check
    CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  CONSTRAINT awcms_mini_subscription_billing_invoices_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT awcms_mini_subscription_billing_invoices_rounding_check
    CHECK (rounding_mode IN ('half_up', 'half_even', 'floor', 'ceil')),
  CONSTRAINT awcms_mini_subscription_billing_invoices_offer_version_check
    CHECK (offer_version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_invoices_version_check
    CHECK (version >= 1),
  -- Exact minor units, bounded to +/- Number.MAX_SAFE_INTEGER so a JS Number()
  -- round-trip is exact (mirrored by the TS parser). subtotal/total may be
  -- negative only via credit lines but never underflow the safe range.
  CONSTRAINT awcms_mini_subscription_billing_invoices_subtotal_range_check
    CHECK (subtotal_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoices_total_range_check
    CHECK (total_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoices_credited_range_check
    CHECK (credited_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoices_allocated_range_check
    CHECK (allocated_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoices_void_reason_size_check
    CHECK (void_reason IS NULL OR length(void_reason) <= 2000),
  CONSTRAINT awcms_mini_subscription_billing_invoices_number_size_check
    CHECK (invoice_number IS NULL OR length(invoice_number) <= 100),
  CONSTRAINT awcms_mini_subscription_billing_invoices_contact_ref_size_check
    CHECK (billing_contact_ref IS NULL OR length(billing_contact_ref) <= 200),
  -- Issued provenance is all-or-nothing.
  CONSTRAINT awcms_mini_subscription_billing_invoices_issued_pair_check
    CHECK ((status = 'draft') OR (issued_at IS NOT NULL))
);

-- IDEMPOTENT GENERATION anchor: at most one non-void invoice per period.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoices_period_key
  ON awcms_mini_subscription_billing_invoices (subscription_id, period_id)
  WHERE status <> 'void' AND period_id IS NOT NULL;

-- Issued invoice numbers, when assigned, are unique per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoices_number_key
  ON awcms_mini_subscription_billing_invoices (tenant_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoices_tenant_status_idx
  ON awcms_mini_subscription_billing_invoices (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoices_tenant_sub_idx
  ON awcms_mini_subscription_billing_invoices (tenant_id, subscription_id, created_at DESC);

ALTER TABLE awcms_mini_subscription_billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_invoices_tenant_isolation
  ON awcms_mini_subscription_billing_invoices
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 4. `awcms_mini_subscription_billing_invoice_lines` — invoice line items.
--    line_type = recurring | usage | credit | adjustment. `amount_minor` is
--    signed bigint minor units. A USAGE line records its reconciliation source
--    (meter_key + window + usage_source_version, AC "record source window/
--    version"). Frozen once the parent invoice is issued.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  invoice_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_invoices (id),
  line_no integer NOT NULL,
  line_type text NOT NULL,
  description text NOT NULL,
  component_key text,
  quantity bigint NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL DEFAULT 0,
  amount_minor bigint NOT NULL,
  -- Usage-line reconciliation source (null for non-usage lines).
  usage_meter_key text,
  usage_window_start timestamptz,
  usage_window_end timestamptz,
  usage_source_version integer,
  usage_source_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_line_no_check
    CHECK (line_no >= 1),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_type_check
    CHECK (line_type IN ('recurring', 'usage', 'credit', 'adjustment')),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_desc_size_check
    CHECK (length(description) BETWEEN 1 AND 500),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_quantity_check
    CHECK (quantity BETWEEN 0 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_unit_range_check
    CHECK (unit_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_amount_range_check
    CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_component_key_size_check
    CHECK (component_key IS NULL OR length(component_key) <= 120),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_meter_key_check
    CHECK (usage_meter_key IS NULL OR (usage_meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(usage_meter_key) <= 120)),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_source_version_check
    CHECK (usage_source_version IS NULL OR usage_source_version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_invoice_lines_metadata_size_check
    CHECK (length(metadata::text) <= 4000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoice_lines_no_key
  ON awcms_mini_subscription_billing_invoice_lines (invoice_id, line_no);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoice_lines_tenant_invoice_idx
  ON awcms_mini_subscription_billing_invoice_lines (tenant_id, invoice_id, line_no);

ALTER TABLE awcms_mini_subscription_billing_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_invoice_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_invoice_lines_tenant_isolation
  ON awcms_mini_subscription_billing_invoice_lines
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 5. `awcms_mini_subscription_billing_invoice_status_history` — APPEND-ONLY
--    provenance of every invoice status change (draft->issued->paid/void),
--    written same-commit as the change.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_invoice_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  invoice_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_invoices (id),
  from_status text,
  to_status text NOT NULL,
  version integer NOT NULL,
  reason text,
  source text NOT NULL DEFAULT 'operator',
  actor uuid,
  correlation_id text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_invoice_status_history_from_check
    CHECK (from_status IS NULL OR from_status IN ('draft', 'issued', 'paid', 'void')),
  CONSTRAINT awcms_mini_subscription_billing_invoice_status_history_to_check
    CHECK (to_status IN ('draft', 'issued', 'paid', 'void')),
  CONSTRAINT awcms_mini_subscription_billing_invoice_status_history_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_invoice_status_history_source_check
    CHECK (source IN ('operator', 'system', 'scheduler', 'payment', 'reconciliation')),
  CONSTRAINT awcms_mini_subscription_billing_invoice_status_history_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoice_status_history_tenant_invoice_idx
  ON awcms_mini_subscription_billing_invoice_status_history (tenant_id, invoice_id, created_at DESC);

ALTER TABLE awcms_mini_subscription_billing_invoice_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_invoice_status_history FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_invoice_status_history_tenant_isolation
  ON awcms_mini_subscription_billing_invoice_status_history
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 6. `awcms_mini_subscription_billing_credit_notes` — a credit note tied to an
--    ORIGINAL issued invoice (and optionally a specific original line). This is
--    the ONLY way to correct an issued invoice (never edit/delete). APPEND-ONLY.
--    `amount_minor` is a POSITIVE bigint (the credited magnitude).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  invoice_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_invoices (id),
  invoice_line_id uuid REFERENCES awcms_mini_subscription_billing_invoice_lines (id),
  credit_number text,
  reason text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  correlation_id text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_credit_notes_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  -- Positive minor units, bounded to Number.MAX_SAFE_INTEGER.
  CONSTRAINT awcms_mini_subscription_billing_credit_notes_amount_range_check
    CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_credit_notes_reason_size_check
    CHECK (length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT awcms_mini_subscription_billing_credit_notes_number_size_check
    CHECK (credit_number IS NULL OR length(credit_number) <= 100)
);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_credit_notes_tenant_invoice_idx
  ON awcms_mini_subscription_billing_credit_notes (tenant_id, invoice_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_credit_notes_number_key
  ON awcms_mini_subscription_billing_credit_notes (tenant_id, credit_number)
  WHERE credit_number IS NOT NULL;

ALTER TABLE awcms_mini_subscription_billing_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_credit_notes FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_credit_notes_tenant_isolation
  ON awcms_mini_subscription_billing_credit_notes
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 7. `awcms_mini_subscription_billing_payment_allocations` — a REFERENCE to a
--    payment settling an invoice (provider ref + amount + which invoice). This
--    is NOT an accounting entry / journal / claim (ADR-0022 §11 boundary) — it
--    is a commercial-state reference recorded ONLY from a validated adapter/
--    reconciliation outcome (#877). APPEND-ONLY. `provider_reference` is an
--    opaque id (no secret); no PII.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  invoice_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_invoices (id),
  -- 'manual' (LAN/offline manual payment reference) or 'provider' (settled via
  -- the #877 adapter outcome). NEVER a provider call in this transaction.
  allocation_source text NOT NULL DEFAULT 'manual',
  provider_key text,
  provider_reference text,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  outcome text NOT NULL DEFAULT 'settled',
  reason text,
  correlation_id text,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_source_check
    CHECK (allocation_source IN ('manual', 'provider')),
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_outcome_check
    CHECK (outcome IN ('settled', 'partial', 'reversed')),
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  -- Signed (a reversal is negative), bounded symmetrically.
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_amount_range_check
    CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_provider_ref_size_check
    CHECK (provider_reference IS NULL OR length(provider_reference) <= 200),
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_provider_key_size_check
    CHECK (provider_key IS NULL OR length(provider_key) <= 100),
  CONSTRAINT awcms_mini_subscription_billing_payment_allocations_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000)
);

-- One allocation per (invoice, provider outcome reference): a replayed
-- provider/reconciliation outcome is recorded ONCE (idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_payment_allocations_ref_key
  ON awcms_mini_subscription_billing_payment_allocations (invoice_id, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_payment_allocations_tenant_invoice_idx
  ON awcms_mini_subscription_billing_payment_allocations (tenant_id, invoice_id, allocated_at DESC);

ALTER TABLE awcms_mini_subscription_billing_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_payment_allocations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_payment_allocations_tenant_isolation
  ON awcms_mini_subscription_billing_payment_allocations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 8. `awcms_mini_subscription_billing_subscription_changes` — scheduled/applied
--    upgrade/downgrade/cancel changes. Records from/to offer, effective time,
--    and application status; PRESERVES old period evidence (AC). A change may be
--    UPDATED only to advance its own lifecycle (scheduled -> applied/canceled);
--    it is never deleted.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_subscription_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  subscription_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_subscriptions (id),
  change_type text NOT NULL,
  from_offer_plan_key text NOT NULL,
  from_offer_version integer NOT NULL,
  to_offer_plan_key text,
  to_offer_version integer,
  proration_policy text NOT NULL DEFAULT 'daily',
  effective_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  reason text,
  correlation_id text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_type_check
    CHECK (change_type IN ('upgrade', 'downgrade', 'cancel')),
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_status_check
    CHECK (status IN ('scheduled', 'applied', 'canceled', 'superseded')),
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_from_version_check
    CHECK (from_offer_version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_to_version_check
    CHECK (to_offer_version IS NULL OR to_offer_version >= 1),
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_proration_check
    CHECK (proration_policy IN ('none', 'daily', 'full_period')),
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000),
  -- cancel has no target offer; upgrade/downgrade must target one.
  CONSTRAINT awcms_mini_subscription_billing_subscription_changes_target_check
    CHECK ((change_type = 'cancel') = (to_offer_plan_key IS NULL))
);

-- At most one scheduled change per subscription (a new schedule supersedes).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_subscription_changes_pending_key
  ON awcms_mini_subscription_billing_subscription_changes (subscription_id)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_subscription_changes_tenant_sub_idx
  ON awcms_mini_subscription_billing_subscription_changes (tenant_id, subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_subscription_changes_due_idx
  ON awcms_mini_subscription_billing_subscription_changes (tenant_id, effective_at)
  WHERE status = 'scheduled';

ALTER TABLE awcms_mini_subscription_billing_subscription_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_subscription_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_subscription_changes_tenant_isolation
  ON awcms_mini_subscription_billing_subscription_changes
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 9. `awcms_mini_subscription_billing_dunning_attempts` — dunning schedule +
--    attempts for a past-due invoice. Each attempt records what lifecycle
--    transition it REQUESTED (through the #873 port — never a direct state
--    write) and the outcome. An attempt row may be UPDATED only to record its
--    own outcome; never deleted.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_dunning_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  invoice_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_invoices (id),
  subscription_id uuid NOT NULL REFERENCES awcms_mini_subscription_billing_subscriptions (id),
  attempt_no integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'scheduled',
  -- The lifecycle state this attempt asked #873 to move the tenant toward
  -- (past_due/grace/suspended), and whether the request succeeded.
  requested_lifecycle_state text,
  lifecycle_outcome text,
  reason text,
  correlation_id text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_subscription_billing_dunning_attempts_attempt_no_check
    CHECK (attempt_no >= 1),
  CONSTRAINT awcms_mini_subscription_billing_dunning_attempts_state_check
    CHECK (state IN ('scheduled', 'executed', 'skipped', 'resolved', 'canceled')),
  CONSTRAINT awcms_mini_subscription_billing_dunning_attempts_requested_state_check
    CHECK (requested_lifecycle_state IS NULL OR requested_lifecycle_state IN ('past_due', 'grace', 'suspended')),
  CONSTRAINT awcms_mini_subscription_billing_dunning_attempts_lifecycle_outcome_check
    CHECK (lifecycle_outcome IS NULL OR lifecycle_outcome IN ('requested', 'applied', 'refused', 'not_available')),
  CONSTRAINT awcms_mini_subscription_billing_dunning_attempts_reason_size_check
    CHECK (reason IS NULL OR length(reason) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_dunning_attempts_no_key
  ON awcms_mini_subscription_billing_dunning_attempts (invoice_id, attempt_no);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_dunning_attempts_due_idx
  ON awcms_mini_subscription_billing_dunning_attempts (tenant_id, scheduled_at)
  WHERE state = 'scheduled';

ALTER TABLE awcms_mini_subscription_billing_dunning_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_dunning_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_dunning_attempts_tenant_isolation
  ON awcms_mini_subscription_billing_dunning_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 10. `awcms_mini_subscription_billing_job_leases` — per-(tenant, job_kind)
--     cooperative lease for the scheduled renewal/invoicing/dunning workers
--     (pattern #872). A worker claims by UPDATE ... WHERE the lease is free or
--     expired, RETURNING; a heartbeat extends it; release clears the holder. A
--     crashed worker's lease expires so another worker safely resumes (AC
--     worker-restart/lease). Bounded, DB-only, offline-safe.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_subscription_billing_job_leases (
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
  CONSTRAINT awcms_mini_subscription_billing_job_leases_kind_check
    CHECK (job_kind IN ('renewal', 'invoicing', 'dunning', 'subscription_change')),
  CONSTRAINT awcms_mini_subscription_billing_job_leases_holder_size_check
    CHECK (holder IS NULL OR length(holder) <= 200),
  CONSTRAINT awcms_mini_subscription_billing_job_leases_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT awcms_mini_subscription_billing_job_leases_last_error_size_check
    CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_subscription_billing_job_leases_key
  ON awcms_mini_subscription_billing_job_leases (tenant_id, job_kind);

ALTER TABLE awcms_mini_subscription_billing_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_subscription_billing_job_leases FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_subscription_billing_job_leases_tenant_isolation
  ON awcms_mini_subscription_billing_job_leases
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- Immutability / write-once / append-only triggers
-- (defence in depth beneath the application-layer guards)
-- =====================================================================

-- Shared: forbid any hard DELETE (a commercial record is never destroyed;
-- correction is a credit note/void/state change — ADR-0022 §6/§9).
CREATE OR REPLACE FUNCTION awcms_mini_subscription_billing_guard_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_billing: % rows are never hard-deleted (correction uses credit-note/void/state-change, never delete)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Shared: fully append-only (reject UPDATE and DELETE).
CREATE OR REPLACE FUNCTION awcms_mini_subscription_billing_guard_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_billing: % is append-only (no UPDATE/DELETE)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Subscriptions: offer binding + identity frozen; forward-legal state machine
-- (whitelist mirrors domain/subscription-state.ts); version +1 on state change.
CREATE OR REPLACE FUNCTION awcms_mini_subscription_billing_guard_subscription_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.offer_plan_key IS DISTINCT FROM OLD.offer_plan_key
     OR NEW.offer_version IS DISTINCT FROM OLD.offer_version
     OR NEW.offer_hash IS DISTINCT FROM OLD.offer_hash
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'subscription_billing: subscription % offer binding (plan/version/hash/currency), tenant_id, started_at, and created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> OLD.state THEN
    IF NOT (
         (OLD.state = 'pending'  AND NEW.state IN ('trialing', 'active', 'canceled'))
      OR (OLD.state = 'trialing' AND NEW.state IN ('active', 'past_due', 'canceled', 'expired'))
      OR (OLD.state = 'active'   AND NEW.state IN ('past_due', 'canceled', 'expired'))
      OR (OLD.state = 'past_due' AND NEW.state IN ('active', 'canceled', 'expired'))
    ) THEN
      RAISE EXCEPTION 'subscription_billing: illegal subscription state transition % -> %', OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'subscription_billing: subscription % version must advance by exactly one on a transition (% -> %)', OLD.id, OLD.version, NEW.version
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.previous_state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'subscription_billing: subscription % previous_state must equal the prior state on a transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'subscription_billing: subscription % version may only change on a state transition', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Invoices: an ISSUED invoice is IMMUTABLE except a forward status advance
-- (issued->paid or issued->void). Amounts/currency/period/subscription/issued
-- provenance are frozen the moment the invoice leaves 'draft'.
CREATE OR REPLACE FUNCTION awcms_mini_subscription_billing_guard_invoice_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'subscription_billing: invoice % tenant_id/subscription_id/created_at are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legal invoice status machine.
  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'draft'  AND NEW.status IN ('issued', 'void'))
      OR (OLD.status = 'issued' AND NEW.status IN ('paid', 'void'))
    ) THEN
      RAISE EXCEPTION 'subscription_billing: illegal invoice status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'subscription_billing: invoice % version must advance by exactly one on a status change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Once the invoice is no longer a draft (OLD status issued/paid/void), the
  -- financial substance is FROZEN: amounts, currency, rounding, offer version,
  -- period, and issued provenance can never change again.
  IF OLD.status <> 'draft' THEN
    IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
       OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.rounding_mode IS DISTINCT FROM OLD.rounding_mode
       OR NEW.offer_version IS DISTINCT FROM OLD.offer_version
       OR NEW.period_id IS DISTINCT FROM OLD.period_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by THEN
      RAISE EXCEPTION 'subscription_billing: issued invoice % is immutable (amounts/currency/period/issued provenance frozen); correct via credit note or void', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Invoice lines: mutable only while the parent invoice is a draft; once the
-- parent is issued the line set is frozen (no UPDATE/DELETE/INSERT-late).
CREATE OR REPLACE FUNCTION awcms_mini_subscription_billing_guard_invoice_line_frozen()
RETURNS trigger AS $$
DECLARE
  parent_status text;
  target_invoice uuid;
BEGIN
  target_invoice := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT status INTO parent_status
    FROM awcms_mini_subscription_billing_invoices
    WHERE id = target_invoice;
  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'subscription_billing: invoice line for invoice % is frozen (parent invoice is %); correct via credit note or void', target_invoice, parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_subscription_billing_subscriptions_immutability
  BEFORE UPDATE ON awcms_mini_subscription_billing_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_subscription_immutability();

CREATE TRIGGER awcms_mini_subscription_billing_subscriptions_no_delete
  BEFORE DELETE ON awcms_mini_subscription_billing_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_no_delete();

CREATE TRIGGER awcms_mini_subscription_billing_invoices_immutability
  BEFORE UPDATE ON awcms_mini_subscription_billing_invoices
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_invoice_immutability();

CREATE TRIGGER awcms_mini_subscription_billing_invoices_no_delete
  BEFORE DELETE ON awcms_mini_subscription_billing_invoices
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_no_delete();

CREATE TRIGGER awcms_mini_subscription_billing_invoice_lines_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON awcms_mini_subscription_billing_invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_invoice_line_frozen();

CREATE TRIGGER awcms_mini_subscription_billing_invoice_status_history_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_subscription_billing_invoice_status_history
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_append_only();

CREATE TRIGGER awcms_mini_subscription_billing_credit_notes_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_subscription_billing_credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_append_only();

CREATE TRIGGER awcms_mini_subscription_billing_payment_allocations_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_subscription_billing_payment_allocations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_append_only();

-- subscription_changes / dunning_attempts: UPDATE is allowed only to advance
-- their own lifecycle status (never delete).
CREATE TRIGGER awcms_mini_subscription_billing_subscription_changes_no_delete
  BEFORE DELETE ON awcms_mini_subscription_billing_subscription_changes
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_no_delete();

CREATE TRIGGER awcms_mini_subscription_billing_dunning_attempts_no_delete
  BEFORE DELETE ON awcms_mini_subscription_billing_dunning_attempts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_subscription_billing_guard_no_delete();

-- =====================================================================
-- Least-privilege grants for the runtime app role (ADR-0022 §12)
-- =====================================================================
--
-- `awcms_mini_app` auto-inherits SELECT/INSERT/UPDATE/DELETE on every new table
-- (migration 013's `ALTER DEFAULT PRIVILEGES`). Narrow to real access:
--   - subscriptions/invoices        : never hard-deleted        -> REVOKE DELETE.
--   - invoice_lines                 : deletable only while draft (trigger) -> keep DELETE (guarded).
--   - status_history/credit_notes/payment_allocations : append-only -> REVOKE UPDATE + DELETE.
--   - subscription_changes/dunning_attempts : lifecycle UPDATE ok  -> REVOKE DELETE.
--   - job_leases                    : churny operational row     -> keep full (bounded by RLS).
REVOKE DELETE ON awcms_mini_subscription_billing_subscriptions FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_subscription_billing_invoices FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_subscription_billing_invoice_status_history FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_subscription_billing_credit_notes FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_subscription_billing_payment_allocations FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_subscription_billing_subscription_changes FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_subscription_billing_dunning_attempts FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_subscription_billing_periods FROM awcms_mini_app;
