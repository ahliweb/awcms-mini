import { defineModule } from "../_shared/module-contract";

/**
 * `payment_gateway` — the SIXTH and LAST SaaS control-plane module (Issue #877,
 * epic #868 Wave 1, ADR-0022). Admitted as an Official Optional Business
 * Foundation: in-repo reviewed code, opt-in per tenant, `defaultTenantState:
 * "disabled"` (ADR-0022 §7) so a LAN/offline/manual-payment deployment that
 * never activates the control plane keeps it fully inert. Payment mutations are
 * PLATFORM-operator only + default-deny; platform payment permissions are
 * SEPARATE from tenant admin.
 *
 * It provides a PROVIDER-NEUTRAL capability for hosted checkout/payment sessions,
 * SIGNED inbound webhooks (fail-closed: HMAC + freshness <=300s + provider/
 * account BINDING + payload size + DURABLE per-event-id anti-replay + event
 * ordering), normalized payment events, refunds where supported, retry/DLQ,
 * provider health + circuit breaker, and reconciliation. Payment status is NEVER
 * trusted from a browser redirect — only from a verified signed webhook or a
 * reconciliation outcome. The PROVIDER CALL always happens OUTSIDE any DB
 * transaction (ADR-0006): the local intent + outbox row commit FIRST; a worker
 * dispatches asynchronously with bounded retry/backoff/DLQ. Provider adapters are
 * OPTIONAL configuration (a derived app wires a real one via
 * `application-registry.ts`); the base ships ONLY a fake/sandbox adapter for
 * tests + docs. Provider SECRETS live in `process.env` only (an `env:` pointer on
 * the account row), NEVER in a table/event/log. Stored webhook envelopes are
 * doc-04 MASKED before persist. Money is EXACT minor units (bigint, never float).
 *
 * It is emphatically NOT a general ledger / AR-AP / double-entry accounting /
 * merchant settlement / tax engine, and it never stores raw card credentials/PAN
 * (ADR-0022 §11). It CONSUMES the read-only `billing_document_state` (#876)
 * contract to learn what is payable and PROVIDES the `payment_outcome` contract
 * (consumed by `subscription_billing` for invoice settlement) — WITHOUT importing
 * `subscription_billing`'s application/domain code (module-boundary). Every table
 * is TENANT-SCOPED (`tenant_id` + `ENABLE` + `FORCE RLS`, predicate ALWAYS AND
 * ONLY `tenant_id` — ADR-0022 §6 no soft super-tenant).
 */
export const paymentGatewayModule = defineModule({
  key: "payment_gateway",
  name: "Payment Gateway",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — gated by
  // `tests/unit/module-governance-default-disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane payment gateway (Issue #877, epic #868 Wave 1, ADR-0022) — the SIXTH and LAST control-plane module. Admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled) and tenant-scoped (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id, ADR-0022 §6 no soft super-tenant). Provides hosted checkout/payment sessions, SIGNED inbound webhooks (fail-closed HMAC + freshness <=300s + provider/account binding + payload-size + DURABLE per-event-id anti-replay + ordering), normalized payment events, refunds where supported, retry/DLQ, provider health + circuit breaker, and reconciliation. Payment status is NEVER trusted from a browser redirect — only from a verified signed webhook or a reconciliation outcome. The provider call ALWAYS happens OUTSIDE any DB transaction (ADR-0006): the local intent + outbox row commit first; a worker dispatches asynchronously. Provider adapters are OPTIONAL configuration wired by a derived application; the base ships only a fake/sandbox adapter for tests + docs. Provider secrets live in process.env only (an env: pointer on the account row), never in a table/event/log; stored webhook envelopes are doc-04 masked before persist. Money is EXACT minor units (bigint, never float). NOT a general ledger / AR-AP / double-entry accounting / merchant settlement / tax engine, and never stores raw card credentials/PAN (ADR-0022 §11). CONSUMES the read-only billing_document_state (#876) contract and PROVIDES the payment_outcome contract (consumed by subscription_billing) — without importing subscription_billing's application/domain. LAN/offline/manual-payment mode runs with no provider configured at all.",
  // ADR-0022 §2 lifecycle dependencies (active first). `logging` for
  // `recordAuditEvent`; `domain_event_runtime` for `appendDomainEvent`.
  // `subscription_billing` (billing_document_state / payment_outcome) and
  // `integration_hub` (webhook/outbox PATTERN reuse) are consumed via
  // CAPABILITY/composition-root wiring (optional, LAN-safe), NOT hard lifecycle
  // dependencies. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The validated payment outcome subscription_billing consumes to settle an invoice.
    provides: ["payment_outcome"],
    consumes: [
      {
        capability: "billing_document_state",
        providedBy: "subscription_billing",
        optional: true
      }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.payment-gateway.intent.initiated",
      "awcms-mini.payment-gateway.intent.pending",
      "awcms-mini.payment-gateway.intent.settled",
      "awcms-mini.payment-gateway.intent.failed",
      "awcms-mini.payment-gateway.intent.expired",
      "awcms-mini.payment-gateway.refund.requested",
      "awcms-mini.payment-gateway.refund.resolved",
      "awcms-mini.payment-gateway.reconciliation.recorded"
    ]
  },
  jobs: [
    {
      command: "bun run payment-gateway:dispatch-outbox",
      purpose:
        "Dispatch pending provider work (checkout create / refund request) OUTSIDE any DB transaction (ADR-0006), with bounded retry/backoff, circuit breaker, and DLQ, under a per-tenant lease. The provider call never holds a source transaction.",
      recommendedSchedule: "*/1 * * * *",
      safeInOfflineLan: true,
      environmentNotes:
        "Requires a provider adapter to be configured (via application-registry.ts) AND a network to the provider; with no adapter/provider the queue simply stays pending (a LAN/offline deployment never enqueues provider work because the module is default-disabled). Provider secrets are resolved from process.env only."
    },
    {
      command: "bun run payment-gateway:reconcile",
      purpose:
        "Compare provider vs local intent state (querying the provider OUTSIDE any transaction) and close drift with an audited correction under a per-tenant lease — the final source of truth beyond a single webhook (provider-outage-safe).",
      recommendedSchedule: "*/15 * * * *",
      safeInOfflineLan: true,
      environmentNotes:
        "DB-only bookkeeping plus an outside-transaction provider status query. With no adapter configured the pass is a clean no-op."
    },
    {
      command: "bun run payment-gateway:expire-sweep",
      purpose:
        "Expire live intents past their window that never received a settling webhook, producing deterministic safe state. DB-only under a per-tenant lease.",
      recommendedSchedule: "*/10 * * * *",
      safeInOfflineLan: true,
      environmentNotes: "DB-only and safe offline/LAN. No provider call."
    }
  ],
  navigation: [
    {
      labelKey: "admin.layout.nav_payment_gateway",
      path: "/admin/payment-gateway",
      order: 135,
      requiredPermission: "payment_gateway.intents.read"
    }
  ],
  permissions: [
    {
      activityCode: "provider_accounts",
      action: "read",
      description:
        "Read provider account bindings (never the signing secret) and provider health"
    },
    {
      activityCode: "provider_accounts",
      action: "configure",
      description:
        "Create or update a provider account binding (env: secret pointer only, allow-listed hosts)"
    },
    {
      activityCode: "intents",
      action: "read",
      description: "Read payment intents/sessions and their status history"
    },
    {
      activityCode: "intents",
      action: "create",
      description:
        "Initiate a hosted checkout/payment session for a payable invoice (dispatched via outbox, outside any DB transaction)"
    },
    {
      activityCode: "intents",
      action: "cancel",
      description:
        "Cancel/expire a payment session where the provider supports it"
    },
    {
      activityCode: "webhooks",
      action: "read",
      description:
        "Read the signed webhook inbox, normalized events, and processing attempts"
    },
    {
      activityCode: "refunds",
      action: "read",
      description: "Read refund requests and their write-once results"
    },
    {
      activityCode: "refunds",
      action: "create",
      description:
        "Request a refund where supported (mandatory reason, idempotency, SoD/step-up)"
    },
    {
      activityCode: "reconciliation",
      action: "read",
      description: "Read reconciliation evidence (local vs provider state)"
    },
    {
      activityCode: "reconciliation",
      action: "update",
      description:
        "Run/resolve reconciliation, closing local-provider drift with an audited correction"
    },
    {
      activityCode: "outbox",
      action: "retry",
      description: "Manually retry a dead-lettered provider dispatch (DLQ)"
    },
    {
      activityCode: "health",
      action: "read",
      description:
        "Read provider adapter health/readiness and circuit-breaker state"
    }
  ],
  health: {
    hasHealthCheck: true,
    hasReadinessCheck: true
  },
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/payment-gateway"
  }
});
