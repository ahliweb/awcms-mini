# subscription_billing

The FIFTH SaaS control-plane module (Issue #876, epic #868 Wave 1, **ADR-0022**)
— an **Official Optional Business Foundation**: in-repo reviewed code, opt-in per
tenant, **`defaultTenantState: "disabled"`**, **tenant-scoped**. It records the
**commercial SaaS STATE** of a tenant's subscription.

## Boundary (ADR-0022 §11) — billing is NOT accounting

`subscription_billing` is **not** a general ledger / double-entry accounting /
AR-AP subledger / tax engine / statutory e-invoicing / cash-bank reconciliation /
tenant business invoice. Payment allocation is a **reference** (provider ref +
amount + which invoice it settles), **never** an accounting entry or claim. The
payment provider is reached only through the `payment_gateway` (#877) adapter
contract — there is **no provider call inside a billing transaction** (ADR-0006).

## What it owns

| Table                                                    | Shape                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `awcms_mini_subscription_billing_subscriptions`          | one subscription; immutable published-offer binding; state machine |
| `awcms_mini_subscription_billing_periods`                | billing periods (stable idempotency anchor)                        |
| `awcms_mini_subscription_billing_invoices`               | draft→issued→{paid,void}; issued = immutable                       |
| `awcms_mini_subscription_billing_invoice_lines`          | recurring/usage/credit/adjustment lines; frozen once issued        |
| `awcms_mini_subscription_billing_invoice_status_history` | append-only status trail                                           |
| `awcms_mini_subscription_billing_credit_notes`           | append-only credit notes tied to an original invoice/line          |
| `awcms_mini_subscription_billing_payment_allocations`    | append-only payment REFERENCES (not a ledger)                      |
| `awcms_mini_subscription_billing_subscription_changes`   | scheduled/applied upgrade/downgrade/cancel (preserves history)     |
| `awcms_mini_subscription_billing_dunning_attempts`       | dunning attempts + requested lifecycle transition outcome          |
| `awcms_mini_subscription_billing_job_leases`             | per-(tenant, job_kind) cooperative lease                           |

Every table is `tenant_id` + `ENABLE`+`FORCE RLS`, predicate ALWAYS AND ONLY
`tenant_id`. Immutability/append-only is enforced by DB triggers beneath the
application guards. REVOKE DELETE on subscriptions/invoices; REVOKE UPDATE+DELETE
on the append-only tables.

## Money is EXACT minor units

`domain/money.ts` is the single money choke point: bigint minor units, **never a
float**, all arithmetic via BigInt, every value bounded to
`Number.MAX_SAFE_INTEGER` (mirrors the DB CHECKs). An invoice is
**single-currency**; the rounding policy is explicit and stored per invoice
(`half_up`/`half_even`/`floor`/`ceil`) with exact-remainder proration.

## Concurrency & idempotency

Every write path row-locks (`FOR UPDATE`) then issues a state/version-predicated
UPDATE → a deterministic 409. **Invoice generation is idempotent per
(subscription, period, offer version)**: the subscription lock serializes
generation and the partial-unique index + `ON CONFLICT DO NOTHING` +
`replayConcurrentIdempotentWinner` guarantee AT MOST ONE invoice per period under
concurrent workers. Scheduled workers use per-(tenant, job_kind) leases + bounded
batches so a crashed worker's lease expires for another to resume.

## Capability ports

- PROVIDES `billing_document_state` (`_shared/ports/billing-document-port.ts`) —
  read-only; consumed by `payment_gateway` (#877).
- CONSUMES `service_catalog_read` (#870), `usage_aggregate` (#875), and
  `lifecycle_transition` (#873), wired ONLY at the composition root
  (`src/pages/api/v1/subscription-billing/_support.ts` + `scripts/*`) — the
  module's own application/domain never imports another module (module-boundary
  gated). Dunning REQUESTS lifecycle transitions through #873 **fail-closed** (an
  error/non-ok result is recorded as not-applied, never assumed applied).

## API & jobs

- Routes: `/api/v1/subscription-billing/tenants/{tenantId}/...` — writes are
  platform-operator only (restricted to the platform tenant); reads allow the
  platform operator OR the tenant's own user (cross-tenant isolated by RLS). All
  high-risk mutations require `Idempotency-Key` + a mandatory reason + audit.
- Jobs: `bun run subscription-billing:run-renewal`,
  `bun run subscription-billing:run-dunning` — DB-only, offline/LAN safe.

See the `awcms-mini-subscription-billing` skill for the full playbook.
