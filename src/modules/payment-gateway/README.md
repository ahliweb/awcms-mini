# Payment Gateway (`payment_gateway`)

The SIXTH and LAST SaaS control-plane module (Issue #877, epic #868 Wave 1,
**ADR-0022**). An Official Optional Business Foundation: in-repo reviewed code,
**opt-in per tenant, `defaultTenantState: "disabled"`**, **tenant-scoped** (every
table `tenant_id` + `ENABLE` + `FORCE RLS`, predicate ALWAYS AND ONLY
`tenant_id`).

Provider-neutral payment: hosted checkout/session, SIGNED inbound webhooks,
normalized payment events, refunds where supported, retry/DLQ, provider health +
circuit breaker, and reconciliation. It records only commercial payment STATE +
provider REFERENCES — it is **NOT** a general ledger / AR-AP / double-entry
accounting / merchant settlement / tax engine, and never stores card
credentials/PAN (ADR-0022 §11).

## Security boundary (non-negotiable)

- **Payment status is NEVER trusted from a browser redirect.** Only a VERIFIED
  signed webhook or a reconciliation outcome advances an intent.
- **The provider call ALWAYS happens OUTSIDE any DB transaction** (ADR-0006): the
  local intent + `outbox` row commit FIRST; the `outbox-dispatch` worker calls
  the provider with no transaction open, then finalizes in a separate
  transaction. A provider outage yields retry/backoff + circuit breaker + DLQ,
  never a held/rolled-back source transaction.
- **Webhook inbox is fail-closed** (`domain/webhook-security.ts`,
  `application/webhook-intake.ts`): HMAC (timing-safe) + freshness (≤300s) +
  provider/account BINDING (cross-tenant substitution guard) + payload size +
  **DURABLE per-event-id anti-replay** (DB unique `(tenant, account,
provider_event_id)`, never in-memory) + event ordering. A valid delivery
  updates payment **exactly once**; every failure is rejected fail-closed with a
  safe error + audit, and an out-of-order/terminal event records reconciliation
  evidence instead of regressing state.
- **SSRF/open-redirect** (`domain/endpoint-allowlist.ts`): endpoint + callback
  hosts are allow-listed per account, validated with `new URL()` + host EQUALITY
  (never a `startsWith` prefix).
- **Provider secrets live in `process.env` only** — the account row stores an
  `env:VAR_NAME` POINTER (`domain/secret-ref.ts`), never the value; nothing
  secret ever reaches a table/event/log/audit.
- **Webhook envelope PII is masked (doc 04) before persist** (`domain/masking.ts`)
  — only a bounded masked snippet, masked provider references, safe error classes.
- **Money is EXACT minor units** (bigint; `domain/money.ts`), never a float.

## Provider adapters (optional configuration)

A real provider (Midtrans/Xendit/Stripe/...) is NEVER hardcoded in the base repo.
The base ships ONLY a fake/sandbox adapter (`infrastructure/sandbox-adapter.ts`)
for tests + docs. A derived application registers its real adapter via
`registerPaymentProviderAdapter` (from `src/modules/application-registry.ts`
bootstrap). With no adapter configured, a LAN/offline/manual-payment deployment
runs fully — payment state is recorded; only online initiation is unavailable.

### Sandbox signing scheme (test/doc reproducibility)

- header `x-sandbox-timestamp`: unix-epoch SECONDS (decimal string)
- header `x-sandbox-signature`: lower-hex HMAC-SHA256 of `${timestamp}.${rawBody}`
- body JSON: `{ event_id, account_ref, session_ref, status, sequence,
amount_minor?, currency? }`

`signSandboxWebhook(secret, rawBody, timestamp)` builds the header pair;
`sandboxControl` (mutable) injects a provider fault / status-query override for
tests without any real network.

## State machines (ADR-0022 §11.5)

- **Payment intent:** `initiated → pending → {settled, failed, expired}`;
  `failed → initiated` (retry); `settled → {refunded, disputed}`. Forward-legal +
  optimistic-concurrency `version` (DB trigger enforced).
- **Refund:** `requested → pending → {succeeded, failed}`; the provider RESULT is
  write-once.

## Capabilities

- CONSUMES `billing_document_state` (#876, read-only) to validate a payable invoice.
- PROVIDES `payment_outcome` (`_shared/ports/payment-outcome-port.ts`): a
  settled/refunded outcome is forwarded to
  `subscription_billing.recordPaymentAllocation` (its own idempotent, audited
  write path) — wired ONLY at the route/job composition root, never imported in
  this module's application/domain.

## Tables (`sql/093`)

`provider_accounts` (binding + `env:` secret pointer + allow-listed hosts),
`payment_intents`, `webhook_inbox` (append-only, anti-replay unique),
`normalized_events` (append-only), `processing_attempts` (append-only),
`outbox` (dispatch queue), `refunds` (write-once result), `reconciliations`
(append-only), `provider_health` (circuit breaker), `job_leases`.

"Append-only" above means **no in-place edit**, enforced by a `BEFORE UPDATE`
trigger per table. It does NOT mean "retained forever": since `sql/102` those
four tables can be aged out by the retention purge below. Before `102` the
triggers were `BEFORE UPDATE OR DELETE` and raised unconditionally, so no role
could delete a row — not even the table owner (Issue #932).

## Retention (`sql/102`, Issue #932)

The evidence chain `webhook_inbox <- normalized_events <-
processing_attempts` (NOT NULL FKs pointing up), plus the independent
`reconciliations`, carry `dataLifecycle` descriptors in `delegated` mode
(`domain/lifecycle-keys.ts`). `application/retention-purge.ts` is the single
delete path: bounded batches, FK-safe order (leaf first, and each level only
deletes rows with no surviving child), legal-hold aware, audited.

The DELETE boundary is a GRANT, not a trigger: `awcms_mini_app` — the role every
HTTP request runs as — is never granted DELETE on any of the four, and
`awcms_mini_worker` is, mirroring `usage_metering`'s migration 087. An
integration test asserts the app role is refused with SQLSTATE `42501`
specifically; a bare "it threw" assertion would also be satisfied by the
foreign-key violation a seeded chain produces, and would miss a wrongly widened
grant.

A legal hold on ANY link of the chain blocks all three of its tables
(fail-closed — a partly purged held chain leaves evidence that cannot be
interpreted). `reconciliations` is held separately.

## Jobs

- `bun run payment-gateway:dispatch-outbox` — dispatch provider work outside any
  transaction, retry/backoff/circuit-breaker/DLQ, per-tenant lease.
- `bun run payment-gateway:reconcile` — provider vs local drift, audited
  correction, per-tenant lease.
- `bun run payment-gateway:expire-sweep` — expire live intents past their window.
- `bun run payment-gateway:purge` — retention purge for the evidence tables
  above; runs as `awcms_mini_worker`, per-tenant lease, safe offline/LAN.

## API

Base path `/api/v1/payment-gateway`. Platform-operator writes (restricted to the
platform tenant, per-tenant context, never BYPASSRLS); read routes allow the
platform operator or the tenant's own user (self-read). The webhook receiver
`POST /api/v1/payment-gateway/webhook/{providerAccountId}` is authenticated by
the opaque account id + provider signature (no tenant JWT).

## Reporting projection (Issue #880)

This module declares `payment_gateway.payment_processing_outcomes` in its own
`module.ts` (keys/labels in `domain/projection-keys.ts`): outcomes of applying
normalized provider events to payment intents (applied, or ignored as
out-of-order / duplicate / terminal / unknown intent), counted incrementally
from the append-only `awcms_mini_payment_gateway_processing_attempts`. This is
the webhook-pipeline health signal — signature-verified events that keep
arriving but cannot be absorbed are invisible in intent state alone. The
envelope-bearing `awcms_mini_payment_gateway_webhook_inbox` is deliberately
NOT the source (it has a guarded status UPDATE path, and no provider
reference, token, or payload may ever reach a projection — ADR-0022
Medium-2). Read under `payment_gateway.reconciliation.read`.

## Admin UI (Issue #878)

`/admin/payment-gateway` (`src/pages/admin/payment-gateway/index.astro`) — the
platform-operator READ surface: provider health + circuit-breaker state,
provider account bindings, and payment intents, looked up per target tenant.
Each of the three sections is gated by its own permission (`health.read`,
`provider_accounts.read`, `intents.read`), so a caller holding only one sees
only that one; the SSR permission set already has every `payment_gateway.*`
key stripped for a tenant that has not enabled this default-disabled module.

Read-only by design. Checkout, cancel, refund request/approve, and outbox
retry are high-risk, reason-and-`Idempotency-Key` mutations — several under
maker/checker SoD and step-up (#879) — so they run through the API and are
deliberately not driven from this screen.

Provider references (`provider_account_ref`, `provider_session_ref`) are
masked to their last four characters. Signing secrets cannot appear at all:
they are `env:` pointers and the API never returns them.

`tests/unit/module-navigation-path-resolves.test.ts` gates the sidebar entry
this module declares against the page actually existing — this module shipped
in #877 with the entry and no page, so a permitted operator's sidebar link
404'd.
