---
"awcms-mini": minor
---

feat(payment-gateway): add provider-neutral checkout, signed webhook inbox, retries, and reconciliation (#877)

The SIXTH and LAST SaaS control-plane module (epic #868 Wave 1, ADR-0022) —
Official Optional Business Foundation, opt-in per tenant, **default-disabled**,
tenant-scoped (every table `tenant_id` + `ENABLE` + `FORCE RLS`, predicate ALWAYS
AND ONLY `tenant_id`).

Provider-neutral payment: hosted checkout/payment sessions, SIGNED inbound
webhooks (fail-closed: timing-safe HMAC + freshness ≤300s + provider/account
BINDING + payload size + DURABLE per-event-id anti-replay + event ordering →
a valid signed webhook updates payment EXACTLY ONCE), normalized payment events,
refunds where supported, retry/DLQ, provider health + circuit breaker, and
reconciliation. Payment status is NEVER trusted from a browser redirect — only a
verified signed webhook or a reconciliation outcome. The PROVIDER CALL always
happens OUTSIDE any DB transaction (ADR-0006): the local intent + outbox row
commit FIRST; a worker dispatches asynchronously. Provider secrets live in
`process.env` only (an `env:` pointer on the account row), never in a
table/event/log; stored webhook envelopes are doc-04 masked before persist. Money
is EXACT minor units (bigint, never float). Provider adapters are OPTIONAL
configuration (a derived app wires a real one via `application-registry.ts`); the
base ships only a fake/sandbox adapter for tests + docs, so LAN/offline/
manual-payment mode runs with no provider configured at all.

CONSUMES `billing_document_state` (#876); PROVIDES `payment_outcome` (consumed by
`subscription_billing`) — without importing subscription_billing's application/
domain. NOT a general ledger / AR-AP / double-entry accounting / merchant
settlement / tax engine, and never stores card credentials/PAN (ADR-0022 §11).

Adds migrations `093`/`094`, module descriptor + permissions (platform-operator
only, default-deny, granted to no role), 10 tenant-scoped tables with immutability/
append-only triggers, OpenAPI + AsyncAPI (8 events), admin navigation, three
scheduled jobs (`payment-gateway:dispatch-outbox|reconcile|expire-sweep`), and a
new project skill `awcms-mini-payment-gateway`.
