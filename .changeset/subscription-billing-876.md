---
"awcms-mini": minor
---

feat(subscription-billing): add subscription, invoice, credit, renewal, and dunning state machines (#876)

The FIFTH SaaS control-plane module (epic #868 Wave 1, ADR-0022) — a
provider-neutral, tenant-scoped, `defaultTenantState: "disabled"` module that
records the commercial SaaS STATE of a tenant's subscription. It is NOT a
general ledger / AR-AP subledger / double-entry accounting / tax engine /
e-invoicing / cash-bank reconciliation / tenant business invoice (ADR-0013 §3 /
ADR-0022 §11) — payment allocation is a REFERENCE only, never an accounting
entry or claim.

- **Schema** (`sql/091`, 10 tables + `sql/092` permissions): subscriptions
  (immutable published-offer binding), billing periods, invoices, invoice lines,
  invoice status history, credit notes, payment allocation references,
  subscription changes, dunning attempts, and per-tenant job leases. RLS
  ENABLE+FORCE on every table, predicate ALWAYS AND ONLY `tenant_id` (no soft
  super-tenant). Immutability triggers freeze the subscription offer binding and
  ISSUED invoices (amounts/currency/period/issued provenance); status history /
  credit notes / payment allocations are append-only; REVOKE DELETE.
- **Money is EXACT minor units** (`domain/money.ts`): bigint minor units, NEVER a
  float — all arithmetic via BigInt, bounded to `Number.MAX_SAFE_INTEGER` at the
  CHECK layer and the parser; single-currency per invoice; explicit rounding
  policy (`half_up`/`half_even`/`floor`/`ceil`) with exact-remainder proration.
- **State machines**: subscription (pending/trialing/active/past_due/canceled/
  expired) and invoice (draft→issued→{paid,void}), forward-legal only with
  optimistic-concurrency version guards (invalid transition → deterministic 409),
  mirrored by DB triggers.
- **Idempotent invoice generation** per (subscription, period, offer version):
  subscription row-lock + partial-unique index + `ON CONFLICT DO NOTHING` +
  `replayConcurrentIdempotentWinner` guarantee AT MOST ONE invoice per period
  under concurrent workers. Usage-based lines reconcile to #875 aggregates and
  record their source window + content hash.
- **Correction is a credit-note or void**, never an edit/delete of an issued
  invoice. Payment state is updated ONLY from a validated manual/provider
  allocation outcome (idempotent by provider reference) — never a provider call
  inside a billing transaction (ADR-0006).
- **Dunning** REQUESTS lifecycle transitions through the #873
  `lifecycle_transition` port (fail-closed: an error/non-ok result is recorded as
  not-applied, never assumed applied) — billing never mutates tenant lifecycle
  state directly.
- **Scheduled workers** (`subscription-billing:run-renewal`,
  `subscription-billing:run-dunning`) use per-(tenant, job_kind) leases + bounded
  batches so multiple workers cooperate idempotently and a crashed worker's lease
  expires for another to resume. DB-only, offline/LAN safe.
- **Ports**: PROVIDES the read-only `billing_document_state` capability (consumed
  by `payment_gateway` #877); CONSUMES `service_catalog_read` (#870),
  `usage_aggregate` (#875), and `lifecycle_transition` (#873) at the composition
  root only (module-boundary gated).
- **API/UI/events/docs**: 18 REST operations under
  `/api/v1/subscription-billing/tenants/{tenantId}/...` (writes = platform
  operator restricted to the platform tenant; reads = platform operator OR the
  tenant's own user, cross-tenant isolated), 8 versioned same-commit domain
  events (OpenAPI + AsyncAPI), an admin panel, audit on every high-risk action
  with a mandatory reason, and `awcms-mini-subscription-billing` skill + module
  README. Blast-radius docs (01/13/21), foundation/governance/boundary/skill-
  coverage tests, and generated inventories updated to 29 modules.
