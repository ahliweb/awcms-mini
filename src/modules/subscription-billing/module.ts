import {
  defineModule,
  type ProjectionCursorStream
} from "../_shared/module-contract";
import {
  INVOICE_LIFECYCLE_METRIC_KEYS,
  INVOICE_LIFECYCLE_PROJECTION_KEY
} from "./domain/projection-keys";

/**
 * ONE stream shared by this projection's `source` and `rebuildSource` — see
 * `tenant-provisioning/module.ts`'s matching constant for the rationale.
 *
 * `created_at` is the cursor, not `effective_at`: `effective_at` is the
 * business timestamp of the status change and may be backdated, so it is not
 * monotonic in insert order. `created_at` is the insert-time default on a
 * table kept append-only by both a trigger and `REVOKE UPDATE, DELETE`
 * (migration 091).
 */
const INVOICE_LIFECYCLE_STREAM: ProjectionCursorStream = {
  streamKey: "invoice_status_history",
  tableName: "awcms_mini_subscription_billing_invoice_status_history",
  cursorColumn: "created_at",
  metrics: [
    {
      metricKey: INVOICE_LIFECYCLE_METRIC_KEYS.transitionTotal,
      effect: "increment"
    },
    {
      metricKey: INVOICE_LIFECYCLE_METRIC_KEYS.toDraftCount,
      effect: "increment",
      matchColumn: "to_status",
      matchValue: "draft"
    },
    {
      metricKey: INVOICE_LIFECYCLE_METRIC_KEYS.toIssuedCount,
      effect: "increment",
      matchColumn: "to_status",
      matchValue: "issued"
    },
    {
      metricKey: INVOICE_LIFECYCLE_METRIC_KEYS.toPaidCount,
      effect: "increment",
      matchColumn: "to_status",
      matchValue: "paid"
    },
    {
      metricKey: INVOICE_LIFECYCLE_METRIC_KEYS.toVoidCount,
      effect: "increment",
      matchColumn: "to_status",
      matchValue: "void"
    }
  ]
};

/**
 * `subscription_billing` — the FIFTH SaaS control-plane module (Issue #876, epic
 * #868 Wave 1, ADR-0022). Admitted as an Official Optional Business Foundation:
 * in-repo reviewed code, opt-in per tenant, and `defaultTenantState: "disabled"`
 * (ADR-0022 §7) so a LAN/offline deployment that never activates the control
 * plane keeps it fully inert. Billing mutations are platform-operator only +
 * default-deny; platform billing permissions are SEPARATE from tenant admin.
 *
 * It records the commercial SaaS STATE of a tenant's subscription — a
 * subscription bound to an IMMUTABLE published offer version (#870), billing
 * periods, invoice drafts/issued documents + line items, credit notes, payment
 * allocation REFERENCES, dunning attempts, and scheduled upgrade/downgrade/
 * cancel changes. It is emphatically NOT a general ledger / AR-AP subledger /
 * double-entry accounting / tax engine / e-invoicing / cash-bank reconciliation
 * / tenant business invoice (ADR-0013 §3 / ADR-0020 §3 / ADR-0022 §11) — payment
 * allocation is a REFERENCE only, never an accounting entry or claim.
 *
 * Every table is TENANT-SCOPED (`tenant_id` + `ENABLE` + `FORCE RLS`, predicate
 * ALWAYS AND ONLY `tenant_id` — no soft super-tenant, ADR-0022 §6). Money is
 * EXACT minor units (bigint, never float); an invoice is single-currency with an
 * explicit rounding policy. Issued invoices are IMMUTABLE (correction via
 * credit-note/void, never edit/delete); invoice generation is IDEMPOTENT per
 * (subscription, period, offer version) under concurrent workers. It CONSUMES
 * the read-only `service_catalog_read` (#870) and `usage_aggregate` (#875)
 * contracts and the `lifecycle_transition` (#873) WRITE contract — dunning
 * REQUESTS lifecycle transitions through #873, never mutating tenant lifecycle
 * state directly (fail-closed). It PROVIDES the read-only `billing_document_state`
 * contract (consumed by `payment_gateway` #877). LAN/offline/manual-payment mode
 * works without any online gateway.
 */
export const subscriptionBillingModule = defineModule({
  key: "subscription_billing",
  name: "Subscription Billing",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — gated by
  // `tests/unit/module-governance-default-disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane subscription billing (Issue #876, epic #868 Wave 1, ADR-0022) — the FIFTH control-plane module. Admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled) and tenant-scoped (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id, ADR-0022 §6 no soft super-tenant). Records the commercial SaaS state of a tenant's subscription: a subscription bound to an IMMUTABLE published offer version (#870), billing periods, invoice drafts/issued documents + line items, credit notes, payment allocation references, dunning attempts, and scheduled upgrade/downgrade/cancel changes. NOT a general ledger / AR-AP / double-entry accounting / tax engine / e-invoicing / cash-bank reconciliation / tenant business invoice (ADR-0013 §3 / ADR-0022 §11) — payment allocation is a reference only, never an accounting entry. Money is EXACT minor units (bigint, never float), single-currency per invoice, explicit rounding policy. Issued invoices are immutable (correction via credit-note/void, never edit/delete); invoice generation is idempotent per (subscription, period, offer version) under concurrent workers with a per-tenant lease. Subscription and invoice state machines are forward-legal with optimistic-concurrency version guards (invalid transition -> deterministic 409). Usage-based lines reconcile to #875 aggregates and record their source window/version. Dunning requests lifecycle transitions through the #873 contract (fail-closed) and never mutates tenant lifecycle state directly. Emits versioned events same-commit and updates reporting projections (#880). PROVIDES the read-only billing_document_state capability (consumed by payment_gateway #877); CONSUMES the read-only service_catalog_read (#870) and usage_aggregate (#875) contracts and the lifecycle_transition (#873) write contract. LAN/offline/manual-payment mode works without an online gateway.",
  // ADR-0022 §2 lifecycle dependencies (active first). `logging` for
  // `recordAuditEvent`; `domain_event_runtime` for `appendDomainEvent`.
  // `service_catalog`/`usage_metering`/`tenant_lifecycle` are consumed via
  // CAPABILITY/composition-root wiring (optional, LAN-safe), NOT hard lifecycle
  // dependencies. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The read-only billing document state #877 consumes to know what is payable.
    provides: ["billing_document_state"],
    consumes: [
      {
        capability: "service_catalog_read",
        providedBy: "service_catalog",
        optional: true
      },
      {
        capability: "usage_aggregate",
        providedBy: "usage_metering",
        optional: true
      },
      {
        capability: "lifecycle_transition",
        providedBy: "tenant_lifecycle",
        optional: true
      }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.subscription-billing.subscription.transitioned",
      "awcms-mini.subscription-billing.subscription.changed",
      "awcms-mini.subscription-billing.invoice.issued",
      "awcms-mini.subscription-billing.invoice.paid",
      "awcms-mini.subscription-billing.invoice.voided",
      "awcms-mini.subscription-billing.invoice.credited",
      "awcms-mini.subscription-billing.payment.recorded",
      "awcms-mini.subscription-billing.dunning.attempted"
    ]
  },
  jobs: [
    {
      command: "bun run subscription-billing:run-renewal",
      purpose:
        "Roll due subscriptions to their next billing period and generate the next invoice draft idempotently under a per-tenant lease (row-lock + partial-unique + ON CONFLICT; at most one invoice per period under concurrent workers). No provider call.",
      recommendedSchedule: "*/30 * * * *",
      safeInOfflineLan: true,
      environmentNotes:
        "DB-only and safe offline/LAN. Reads the published catalog (#870) and usage aggregates (#875) through capability ports wired at the composition root; if neither is enabled the job is a clean no-op. A FLEET-WIDE batch scanning every tenant is intentionally scoped by the shared tenant iterator (a platform operator is not a soft super-tenant, ADR-0022 §6)."
    },
    {
      command: "bun run subscription-billing:run-dunning",
      purpose:
        "Run dunning for past-due issued invoices under a per-tenant lease; each attempt REQUESTS a lifecycle transition through the #873 contract (fail-closed) — billing never mutates tenant lifecycle state directly.",
      recommendedSchedule: "0 * * * *",
      safeInOfflineLan: true,
      environmentNotes:
        "DB-only and safe offline/LAN. The lifecycle transition is requested through the #873 lifecycle_transition port wired at the composition root; if tenant_lifecycle is not enabled the attempt is recorded as not_available and NO lifecycle change is asserted (billing never bypasses #873 policy)."
    }
  ],
  navigation: [
    {
      labelKey: "admin.layout.nav_subscription_billing",
      path: "/admin/subscription-billing",
      order: 134,
      requiredPermission: "subscription_billing.invoices.read"
    }
  ],
  permissions: [
    {
      activityCode: "subscriptions",
      action: "read",
      description: "Read subscriptions, billing periods, and commercial state"
    },
    {
      activityCode: "subscriptions",
      action: "create",
      description:
        "Create a subscription bound to an immutable published offer version"
    },
    {
      activityCode: "subscriptions",
      action: "update",
      description:
        "Perform a validated subscription state transition (activate, past_due, cancel, expire; concurrency-safe)"
    },
    {
      activityCode: "invoices",
      action: "read",
      description:
        "Read invoices, line items, status history, and download metadata"
    },
    {
      activityCode: "invoices",
      action: "create",
      description:
        "Generate an idempotent invoice draft from catalog prices and usage aggregates"
    },
    {
      activityCode: "invoices",
      action: "issue",
      description: "Issue a draft invoice (issued invoices become immutable)"
    },
    {
      activityCode: "invoices",
      action: "void",
      description:
        "Void an invoice with a mandatory reason (correction, never edit/delete)"
    },
    {
      activityCode: "credits",
      action: "create",
      description:
        "Create (MAKER) a credit note in pending_approval — does not reduce the invoice balance"
    },
    {
      activityCode: "credits",
      action: "approve",
      description:
        "Approve (CHECKER) a pending credit note — distinct actor (SoD) + step-up; applies it to the invoice balance"
    },
    {
      activityCode: "payments",
      action: "update",
      description:
        "Record a validated manual/provider payment allocation reference (no accounting ledger)"
    },
    {
      activityCode: "changes",
      action: "update",
      description:
        "Schedule/cancel a deterministic subscription upgrade/downgrade/cancel preserving historical terms"
    },
    {
      activityCode: "dunning",
      action: "update",
      description:
        "Run/schedule dunning attempts that request lifecycle transitions through the #873 contract"
    }
  ],
  // Segregation-of-duties (Issue #879, epic #868 Wave 2, ADR-0022 §5 —
  // "invoice/credit/refund creation versus approval"). SoD was DEFERRED from
  // #876 to #879; declared here, wired into the `authorizeInTransaction`
  // chokepoint via `high-risk-sod-guard.ts`. Enforced at the high-risk
  // `invoices.issue` step (freezing a draft into an immutable commercial
  // document): the subject who CREATED the draft invoice must not also be the
  // one who ISSUES it — maker/checker over billing documents.
  sodRules: [
    {
      ruleKey: "subscription_billing.invoice_create_vs_issue",
      ownerModuleKey: "subscription_billing",
      description:
        "A subject who CREATES a draft invoice must not also ISSUE (freeze) it into an immutable commercial document — invoice maker/checker (ADR-0022 §5 invoice/credit/refund creation vs approval).",
      conflictingPermissionKeys: [
        "subscription_billing.invoices.create",
        "subscription_billing.invoices.issue"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "high",
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission:
          "identity_access.business_scope_exceptions.approve",
        maxDurationDays: 14
      }
    },
    {
      // Issue #879 (ADR-0022 §5 CRITICAL-1) — credit maker/checker. Fires at the
      // high-risk `credits.approve` action: a subject who CREATED a pending credit
      // note must not also APPROVE (apply) it to a tenant's invoice balance.
      ruleKey: "subscription_billing.credit_create_vs_approve",
      ownerModuleKey: "subscription_billing",
      description:
        "A subject who CREATES a credit note must not also APPROVE (apply) it to the invoice balance — credit maker/checker (ADR-0022 §5 invoice/credit/refund creation vs approval).",
      conflictingPermissionKeys: [
        "subscription_billing.credits.create",
        "subscription_billing.credits.approve"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "high",
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission:
          "identity_access.business_scope_exceptions.approve",
        maxDurationDays: 14
      }
    }
  ],
  // Issue #880 — see `tenant-provisioning/module.ts`'s matching block.
  reportingProjections: [
    {
      key: INVOICE_LIFECYCLE_PROJECTION_KEY,
      version: 1,
      ownerModuleKey: "subscription_billing",
      scope: "tenant",
      description:
        "Invoice status-transition counts (draft/issued/paid/void) for this tenant, incrementally derived from the append-only awcms_mini_subscription_billing_invoice_status_history. Issued minus paid is the collection backlog an operator watches, and a rising to_void_count is correction churn. Deliberately COUNTS ONLY, never amounts: this is not a general ledger, AR-AP, or aged-receivable report (ADR-0013 §3, ADR-0022 §11), and exact minor-unit money must never live in an increment-only counter that cannot be corrected downward. Amounts, currency, and per-invoice state stay authoritative in the invoice rows (drill down).",
      source: {
        strategy: "cursor_table",
        streams: [INVOICE_LIFECYCLE_STREAM]
      },
      rebuildSource: { streams: [INVOICE_LIFECYCLE_STREAM] },
      metricLabels: {
        [INVOICE_LIFECYCLE_METRIC_KEYS.transitionTotal]:
          "Invoice status transitions",
        [INVOICE_LIFECYCLE_METRIC_KEYS.toDraftCount]: "To draft",
        [INVOICE_LIFECYCLE_METRIC_KEYS.toIssuedCount]: "To issued",
        [INVOICE_LIFECYCLE_METRIC_KEYS.toPaidCount]: "To paid",
        [INVOICE_LIFECYCLE_METRIC_KEYS.toVoidCount]: "To void"
      },
      requiredPermission: "subscription_billing.invoices.read",
      freshness: {
        targetSeconds: 300,
        staleAfterSeconds: 900,
        errorAfterConsecutiveFailures: 3
      },
      drillDownPath: "/api/v1/subscription-billing/tenants/{tenantId}/invoices",
      retentionClass:
        "Not separately registered in data_lifecycle: a few rows per invoice per billing period. It is also the provenance trail of every issued/paid/void decision on a financial document, so age-based purge is deliberately not proposed (financial_tax retention would in any case be the longest class in the registry).",
      batchLimit: 1000
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/subscription-billing"
  }
});
