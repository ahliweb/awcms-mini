import {
  defineModule,
  type ProjectionCursorStream
} from "../_shared/module-contract";
import {
  PAYMENT_PROCESSING_METRIC_KEYS,
  PAYMENT_PROCESSING_PROJECTION_KEY
} from "./domain/projection-keys";
import {
  PAYMENT_GATEWAY_NORMALIZED_EVENTS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_PROCESSING_ATTEMPTS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_OUTBOX_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_WEBHOOK_INBOX_LIFECYCLE_KEY
} from "./domain/lifecycle-keys";

/**
 * ONE stream shared by this projection's `source` and `rebuildSource` — see
 * `tenant-provisioning/module.ts`'s matching constant for the rationale.
 *
 * `created_at` is the cursor on a table kept append-only by both a trigger
 * and `REVOKE UPDATE, DELETE` (migration 093). Only the metric key and an
 * integer are ever stored — no provider reference, envelope, or token can
 * reach the projection through this contract (ADR-0022 Medium-2).
 */
const PAYMENT_PROCESSING_STREAM: ProjectionCursorStream = {
  streamKey: "payment_processing_attempts",
  tableName: "awcms_mini_payment_gateway_processing_attempts",
  cursorColumn: "created_at",
  metrics: [
    {
      metricKey: PAYMENT_PROCESSING_METRIC_KEYS.attemptTotal,
      effect: "increment"
    },
    {
      metricKey: PAYMENT_PROCESSING_METRIC_KEYS.appliedCount,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "applied"
    },
    {
      metricKey: PAYMENT_PROCESSING_METRIC_KEYS.ignoredOutOfOrderCount,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "ignored_out_of_order"
    },
    {
      metricKey: PAYMENT_PROCESSING_METRIC_KEYS.ignoredDuplicateCount,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "ignored_duplicate"
    },
    {
      metricKey: PAYMENT_PROCESSING_METRIC_KEYS.ignoredTerminalCount,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "ignored_terminal"
    },
    {
      metricKey: PAYMENT_PROCESSING_METRIC_KEYS.ignoredUnknownIntentCount,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "ignored_unknown_intent"
    }
  ]
};

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
    },
    {
      command: "bun run payment-gateway:purge",
      purpose:
        "Delete payment webhook evidence (processing attempts, normalized events, webhook inbox) and reconciliation logs past their retention cutoff, in FK-safe order and bounded batches, honoring legal holds. The ONLY delete path for these tables (Issue #932) — before migration 102 no role could delete from them at all, so the evidence grew without bound.",
      recommendedSchedule: "0 3 * * *",
      safeInOfflineLan: true,
      environmentNotes:
        "Pure PostgreSQL operation, no provider call or network egress. Runs as awcms_mini_worker, the only role granted DELETE on these tables (awcms_mini_app still cannot delete). Retention resolves from --retention-days=<n>, then PAYMENT_EVIDENCE_RETENTION_DAYS, then the 400-day default. A no-op on a deployment where the control plane is disabled."
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
        "Request (MAKER) a refund where supported — mandatory reason + idempotency; does NOT dispatch money"
    },
    {
      activityCode: "refunds",
      action: "approve",
      description:
        "Approve (CHECKER) a requested refund — distinct actor (SoD) + step-up; enqueues the provider dispatch (money-out)"
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
  // Segregation-of-duties (Issue #879, epic #868 Wave 2, ADR-0022 §5 —
  // payment/refund/reconciliation separation). SoD was DEFERRED from #877 to
  // #879; declared here, wired into the `authorizeInTransaction` chokepoint via
  // `high-risk-sod-guard.ts`. Enforced at the high-risk
  // `provider_accounts.configure` step: the subject who CONFIGURES a payment
  // provider binding (controlling WHERE settlement money flows) must not also
  // be able to CREATE refunds — a single actor holding both can redirect
  // settlement AND move money back out, the strongest control-plane fraud
  // vector. Global-within-tenant, critical.
  sodRules: [
    {
      // Issue #879 (ADR-0022 §5 CRITICAL-1) — the REAL money-out maker/checker.
      // Fires at the high-risk `approve` action: a subject who REQUESTED a refund
      // (holds `refunds.create`) must not also APPROVE it. Money leaves only after
      // a second, distinct actor approves. `refunds.approve` IS a high-risk action
      // so the SoD chokepoint runs here (unlike the old rule, which paired
      // `refunds.create` — a non-high-risk action the chokepoint never evaluated).
      ruleKey: "payment_gateway.refund_create_vs_approve",
      ownerModuleKey: "payment_gateway",
      description:
        "A subject who REQUESTS (creates) a refund must not also APPROVE it — refund maker/checker; the provider dispatch (money-out) is enqueued only on approval by a distinct actor (ADR-0022 §5 refund creation vs approval).",
      conflictingPermissionKeys: [
        "payment_gateway.refunds.create",
        "payment_gateway.refunds.approve"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "critical",
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission:
          "identity_access.business_scope_exceptions.approve",
        maxDurationDays: 7
      }
    },
    {
      // Retained separation of settlement control from disbursement. Enforced at
      // the high-risk `approve` action (approving a refund while also controlling
      // WHERE money settles is the strongest fraud combination).
      ruleKey: "payment_gateway.provider_config_vs_refund_approve",
      ownerModuleKey: "payment_gateway",
      description:
        "A subject who CONFIGURES a payment provider binding (where money settles) must not also APPROVE refunds (where money returns) — anti-fraud separation of settlement control from disbursement (ADR-0022 §5 payment/refund separation).",
      conflictingPermissionKeys: [
        "payment_gateway.provider_accounts.configure",
        "payment_gateway.refunds.approve"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "critical",
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission:
          "identity_access.business_scope_exceptions.approve",
        maxDurationDays: 7
      }
    }
  ],
  health: {
    hasHealthCheck: true,
    hasReadinessCheck: true
  },
  // Issue #932 — the four tables that grow with real provider traffic. All
  // registered as "delegated" adopters: `data_lifecycle`'s engine may READ
  // them for dry-run backlog counts, but the real delete stays owned by
  // `purgeExpiredPaymentEvidence` (`bun run payment-gateway:purge`), which
  // honors legal holds against these same keys and deletes in FK-safe order.
  //
  // Until migration 102 NONE of them could be purged by any role at all — the
  // append-only triggers refused DELETE outright, so "append-only" meant
  // "retained forever". Those triggers are now `BEFORE UPDATE` (every
  // in-place-edit protection unchanged) and DELETE is a grant held only by
  // `awcms_mini_worker`.
  dataLifecycle: [
    {
      key: PAYMENT_GATEWAY_WEBHOOK_INBOX_LIFECYCLE_KEY,
      tableName: "awcms_mini_payment_gateway_webhook_inbox",
      ownerModuleKey: "payment_gateway",
      scope: "tenant",
      cursorColumn: "received_at",
      retentionClass: "audit_security",
      retentionMinDays: 180,
      retentionMaxDays: 2555,
      defaultRetentionDays: 400,
      partition: {
        eligible: true,
        granularity: "monthly",
        rationale:
          "Highest insert rate of any table this module owns (one row per inbound provider webhook, including replays and rejected signatures), append-only, purged by age only — a textbook monthly range-partition candidate. Not automated here (destructive migration is out of scope); tracked as partitioning runbook guidance in docs/awcms-mini/data-lifecycle.md."
      },
      archive: {
        archivable: false,
        rationale:
          "Current reality: purgeExpiredPaymentEvidence performs a bounded age-based DELETE with no archive step. The commercially meaningful outcome of every webhook already survives separately and longer in payment_intents/refunds, which this purge never touches; declaring archivable:true without a real archive step would be inaccurate."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Age-only cutoff, and only for rows with no surviving normalized event referencing them (the FK-safe ordering). Anonymization is not applicable: the row holds no personal data by construction — the envelope is masked before persist (ADR-0022 Medium-2), leaving a provider event id, a body hash/size, and a verification outcome."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "received_at"],
          purpose:
            "awcms_mini_payment_gateway_webhook_inbox_retention_idx (migration 102) — the age-ordered bounded scan the purge relies on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact exists (archive.archivable is false above). A restore predating a purge legitimately reintroduces rows the purge had aged out; the next scheduled run removes them again.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run payment-gateway:purge",
        purgeFunctionRef:
          "src/modules/payment-gateway/application/retention-purge.ts#purgeExpiredPaymentEvidence",
        description:
          "Deletes webhook inbox rows past the retention cutoff that no surviving normalized event references, in bounded batches, honoring an active legal hold on any link of the evidence chain. The same function the scheduled job calls."
      }
    },
    {
      key: PAYMENT_GATEWAY_NORMALIZED_EVENTS_LIFECYCLE_KEY,
      tableName: "awcms_mini_payment_gateway_normalized_events",
      ownerModuleKey: "payment_gateway",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "audit_security",
      retentionMinDays: 180,
      retentionMaxDays: 2555,
      defaultRetentionDays: 400,
      partition: {
        eligible: false,
        rationale:
          "One row per SUCCESSFULLY verified and normalized webhook, so strictly fewer rows than the inbox above (replays and signature failures never reach it) and comfortably handled by the age-ordered index. Partitioning would add operational surface for no measured benefit; revisit if a deployment's inbox partitioning proves insufficient."
      },
      archive: {
        archivable: false,
        rationale:
          "Same as the inbox: no archive step exists, and the resulting payment state is retained separately in payment_intents."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Age-only cutoff, and only for rows with no surviving processing attempt referencing them (FK-safe ordering). Numeric/enumerated provider event data only — nothing to anonymize."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_mini_payment_gateway_normalized_events_retention_idx (migration 102) — the age-ordered bounded scan."
        },
        {
          columns: ["webhook_inbox_id"],
          purpose:
            "awcms_mini_payment_gateway_normalized_events_inbox_idx (migration 102) — the surviving-child probe that keeps the inbox purge FK-safe."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run payment-gateway:purge",
        purgeFunctionRef:
          "src/modules/payment-gateway/application/retention-purge.ts#purgeExpiredPaymentEvidence",
        description:
          "Deletes normalized events past the retention cutoff that no surviving processing attempt references, in bounded batches, honoring an active legal hold on any link of the evidence chain."
      }
    },
    {
      key: PAYMENT_GATEWAY_PROCESSING_ATTEMPTS_LIFECYCLE_KEY,
      tableName: "awcms_mini_payment_gateway_processing_attempts",
      ownerModuleKey: "payment_gateway",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "audit_security",
      retentionMinDays: 180,
      retentionMaxDays: 2555,
      defaultRetentionDays: 400,
      partition: {
        eligible: false,
        rationale:
          "One row per attempt to apply a normalized event to an intent — same order of magnitude as normalized events, and the leaf of the chain. Age-ordered index is sufficient; see the inbox descriptor for where partitioning would be applied first."
      },
      archive: {
        archivable: false,
        rationale:
          "No archive step exists. This log answers 'why did this provider event not change the intent', which is an operational question with a bounded useful life, not a record retained for its own sake."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Age-only cutoff. Nothing references a processing attempt, so it is purged first and needs no surviving-child probe. Enumerated outcome plus a short detail string — nothing to anonymize."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_mini_payment_gateway_processing_attempts_tenant_created_idx (migration 101) — the age-ordered bounded scan, shared with the reporting projection's cursor."
        },
        {
          columns: ["normalized_event_id"],
          purpose:
            "awcms_mini_payment_gateway_processing_attempts_event_idx (migration 102) — the surviving-child probe that keeps the normalized-event purge FK-safe."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run payment-gateway:purge",
        purgeFunctionRef:
          "src/modules/payment-gateway/application/retention-purge.ts#purgeExpiredPaymentEvidence",
        description:
          "Deletes processing attempts past the retention cutoff (the leaf of the evidence chain, purged first), in bounded batches, honoring an active legal hold on any link of the chain."
      }
    },
    {
      key: PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY,
      tableName: "awcms_mini_payment_gateway_reconciliations",
      ownerModuleKey: "payment_gateway",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "audit_security",
      retentionMinDays: 180,
      retentionMaxDays: 2555,
      defaultRetentionDays: 400,
      partition: {
        eligible: false,
        rationale:
          "One row per reconciliation comparison, written by a scheduled job rather than by provider traffic — the lowest-volume of the four and not a partitioning candidate."
      },
      archive: {
        archivable: false,
        rationale:
          "No archive step exists. A reconciliation outcome that has aged out is superseded by every later reconciliation of the same intent."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Age-only cutoff. References payment intents (never purged here) and is referenced by nothing, so it needs no surviving-child probe and is independent of the webhook evidence chain — including for legal holds, which are placed on this key separately."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_mini_payment_gateway_reconciliations_retention_idx (migration 102) — the age-ordered bounded scan."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run payment-gateway:purge",
        purgeFunctionRef:
          "src/modules/payment-gateway/application/retention-purge.ts#purgeExpiredPaymentEvidence",
        description:
          "Deletes reconciliation log rows past the retention cutoff, in bounded batches, honoring an active legal hold on this key (held independently of the webhook evidence chain)."
      }
    },
    {
      key: PAYMENT_GATEWAY_OUTBOX_LIFECYCLE_KEY,
      tableName: "awcms_mini_payment_gateway_outbox",
      ownerModuleKey: "payment_gateway",
      scope: "tenant",
      // `updated_at`, not `created_at` like the other four: a command queued
      // months ago that only reached `dead` today has been finished for zero
      // days. This ages on when the command STOPPED BEING LIVE.
      cursorColumn: "updated_at",
      // `operational_queue` rather than `audit_security`: this is the outbound
      // command queue, not evidence of what a provider did. The commercial
      // outcome any command produced is recorded in payment_intents/refunds,
      // which this purge never touches, and the provider's own account of it
      // is the webhook evidence chain above.
      retentionClass: "operational_queue",
      retentionMinDays: 30,
      retentionMaxDays: 730,
      defaultRetentionDays: 180,
      partition: {
        eligible: false,
        rationale:
          "Highest write volume in the module (one row per outbound command, and query_status polls), but the working set is small by construction: only terminal rows are ever retained, and the partial retention index keeps the aged-out scan off the live queue entirely. Revisit if a deployment measures the terminal backlog outgrowing that index."
      },
      archive: {
        archivable: false,
        rationale:
          "No archive step exists, and a terminal command carries no information not already in the resulting intent/refund state plus the provider's own webhook evidence."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Age on updated_at AND terminal status only ('succeeded'/'dead'). The status half is not an optimisation: a pending/in_flight/failed row is work that still owes a customer something, and deleting one would silently drop a checkout, refund, or cancellation with the retry loop simply never seeing it again. Note that 'failed' is RETRYABLE despite the name — it shares the due index with 'pending'."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "updated_at"],
          purpose:
            "awcms_mini_payment_gateway_outbox_retention_idx (migration 106) — the age-ordered bounded scan, PARTIAL on status IN ('succeeded','dead') so the safe predicate is also the fast one: a purge that forgot the status filter would be both wrong and slow rather than quietly wrong."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run payment-gateway:purge",
        purgeFunctionRef:
          "src/modules/payment-gateway/application/retention-purge.ts#purgeExpiredPaymentEvidence",
        description:
          "Deletes TERMINAL outbound commands past the retention cutoff, in bounded batches, honoring an active legal hold on this key (held independently of both the evidence chain and the reconciliation log). Live commands are never eligible."
      }
    }
  ],
  // Issue #880 — see `tenant-provisioning/module.ts`'s matching block.
  reportingProjections: [
    {
      key: PAYMENT_PROCESSING_PROJECTION_KEY,
      version: 1,
      ownerModuleKey: "payment_gateway",
      scope: "tenant",
      description:
        "Outcomes of applying normalized provider events to this tenant's payment intents (applied, or ignored as out-of-order/duplicate/terminal/unknown intent), incrementally derived from the append-only awcms_mini_payment_gateway_processing_attempts. This is the webhook-pipeline health signal: signature-verified events that keep arriving but cannot be absorbed (out-of-order, unknown intent) are invisible in intent state alone, and a flat applied_count while provider activity continues means payment status has stopped tracking the provider. Provider references, envelopes, and tokens are never projected — only a metric key and an integer are stored (ADR-0022 Medium-2). Payment status remains authoritative only in the intents themselves, updated exclusively by signed webhook or reconciliation.",
      source: {
        strategy: "cursor_table",
        streams: [PAYMENT_PROCESSING_STREAM]
      },
      rebuildSource: { streams: [PAYMENT_PROCESSING_STREAM] },
      metricLabels: {
        [PAYMENT_PROCESSING_METRIC_KEYS.attemptTotal]:
          "Provider event applications attempted",
        [PAYMENT_PROCESSING_METRIC_KEYS.appliedCount]: "Applied",
        [PAYMENT_PROCESSING_METRIC_KEYS.ignoredOutOfOrderCount]:
          "Ignored (out of order)",
        [PAYMENT_PROCESSING_METRIC_KEYS.ignoredDuplicateCount]:
          "Ignored (duplicate)",
        [PAYMENT_PROCESSING_METRIC_KEYS.ignoredTerminalCount]:
          "Ignored (terminal state)",
        [PAYMENT_PROCESSING_METRIC_KEYS.ignoredUnknownIntentCount]:
          "Ignored (unknown intent)"
      },
      requiredPermission: "payment_gateway.reconciliation.read",
      freshness: {
        targetSeconds: 300,
        staleAfterSeconds: 900,
        errorAfterConsecutiveFailures: 3
      },
      drillDownPath: "/api/v1/payment-gateway/tenants/{tenantId}/health",
      retentionClass:
        "payment_gateway.processing_attempts — registered in this module's own dataLifecycle array above (Issue #932), age-purged by `bun run payment-gateway:purge`. NOTE that this projection's counters are ALL-TIME while its source table is purged, so a reconciliation run against it will report a growing shortfall as old attempts age out; that is retention working, not projection drift. See docs/awcms-mini/data-lifecycle.md.",
      batchLimit: 1000
    }
  ],
  // Issue #930 (epic #868). Two objectives with deliberately different
  // shapes: the DLQ is not a backlog (every row there is permanently lost
  // work until a human acts), while the webhook inbox is one (rows drain on
  // their own once normalization catches up).
  serviceLevelObjectives: [
    {
      key: "payment_gateway.dead_letter_queue_drained",
      ownerModuleKey: "payment_gateway",
      title: "Payment dead-letter queue stays empty",
      description:
        "The provider outbox dead-letter queue holds nothing. Every row here is provider work that exhausted its retries and will NEVER be attempted again without operator action — so this is not a backlog that drains on its own, it is permanent loss until someone acts.",
      kind: "backlog",
      metricName: "control_plane_payment_dlq_depth",
      unit: "count",
      objectiveValue: 0,
      objectiveComparison: "above",
      runbookPath:
        "docs/awcms-mini/control-plane-slo-runbook.md#payment-gateway-dlq",
      thresholds: [
        {
          thresholdKey: "dlq_non_empty",
          severity: "warning",
          comparison: "above",
          value: 0,
          forSeconds: 1800,
          operatorAction:
            "Read the masked failure reasons through the operator API. Check whether an open provider circuit breaker is the upstream cause before touching the queue."
        },
        {
          thresholdKey: "dlq_accumulating",
          severity: "critical",
          comparison: "above",
          value: 25,
          forSeconds: 1800,
          operatorAction:
            "Do not bulk-requeue until the underlying cause is gone — requeueing into a provider that is still down only moves the problem and burns the retry budget again."
        }
      ]
    },
    {
      key: "payment_gateway.webhook_backlog_absorbed",
      ownerModuleKey: "payment_gateway",
      title: "Received webhooks get normalized",
      description:
        "Signature-verified provider webhooks that arrive are absorbed into normalized events. Envelopes that keep arriving but are never absorbed are invisible in payment-intent state alone — the same blind spot this module's reporting projection exists to cover.",
      kind: "backlog",
      metricName: "control_plane_webhook_backlog",
      unit: "count",
      objectiveValue: 100,
      objectiveComparison: "above",
      runbookPath:
        "docs/awcms-mini/control-plane-slo-runbook.md#payment-gateway-webhook-backlog",
      thresholds: [
        {
          thresholdKey: "webhook_backlog_elevated",
          severity: "warning",
          comparison: "above",
          value: 100,
          forSeconds: 900,
          operatorAction:
            "If the backlog grows while provider call metrics look normal, the fault is on our normalization side rather than the provider's delivery."
        },
        {
          thresholdKey: "webhook_backlog_critical",
          severity: "critical",
          comparison: "above",
          value: 1000,
          forSeconds: 900,
          operatorAction:
            "Payment outcomes are not reaching intents; expect settlement state to be stale fleet-wide and communicate accordingly while the pipeline is restored."
        }
      ]
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/payment-gateway"
  }
});
