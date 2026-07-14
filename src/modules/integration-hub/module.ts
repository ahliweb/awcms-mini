import { defineModule } from "../_shared/module-contract";
import { INTEGRATION_HUB_PERMISSIONS } from "./domain/integration-permissions";

export const integrationHubModule = defineModule({
  key: "integration_hub",
  name: "Integration Hub",
  version: "0.1.0",
  status: "active",
  description:
    "Generic, provider-neutral integration boundary (Issue #754, epic `platform-evolution` #738 Wave 3 — System Foundation per ADR-0013 §1/§6, admission decision `docs/adr/0017-integration-hub-module-admission.md`). Signed inbound webhook endpoints (opaque server-generated tokens, per-endpoint HMAC secret with timing-safe verification and key rotation-with-overlap), DB-uniqueness-enforced replay protection (never an in-memory-only check), normalization of verified inbound messages into this repo's own domain-event shape via `domain_event_runtime` (Issue #742), outbound event subscriptions with a bounded declarative filter and SSRF-guarded delivery, and per-adapter health tracking. Provider-specific mapping/credentials always stay owned by the module that owns that capability — this hub ships exactly two self-contained FIXTURE inbound signature schemes and one generic outbound HTTP adapter (zero real business integrations, mirroring the accepted #643/#742 foundation-issue precedent) plus a capability port (`_shared/ports/integration-adapter-port.ts`) a future provider-owning module implements to register its own adapter. Outbound delivery dispatch (`bun run integration-hub:outbound:dispatch`) never runs a network call inside a DB transaction (ADR-0006) — a same-process, DB-only `domain_event_runtime` consumer fans a normalized event out to matching subscriptions as `pending` rows inside the SAME transaction as the source event's own commit; the real HTTP call happens later, outside any transaction, with retry/backoff/dead-letter/operator-safe-replay.",
  dependencies: ["tenant_admin", "identity_access", "domain_event_runtime"],
  type: "system",
  capabilities: {
    provides: ["integration_adapter_registration"]
  },
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/integration-hub"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: ["awcms-mini.integration-hub.inbound-message.normalized"],
    subscribes: ["awcms-mini.integration-hub.inbound-message.normalized"]
  },
  permissions: INTEGRATION_HUB_PERMISSIONS.map((permission) => ({
    activityCode: permission.activityCode,
    action: permission.action,
    description: permission.description
  })),
  navigation: [
    {
      labelKey: "admin.layout.nav_integration_hub_endpoints",
      path: "/admin/integration-hub/endpoints",
      icon: "webhook",
      group: "integrations",
      order: 10,
      requiredPermission: "integration_hub.endpoints.read"
    },
    {
      labelKey: "admin.layout.nav_integration_hub_subscriptions",
      path: "/admin/integration-hub/subscriptions",
      icon: "share-2",
      group: "integrations",
      order: 20,
      requiredPermission: "integration_hub.subscriptions.read"
    },
    {
      labelKey: "admin.layout.nav_integration_hub_deliveries",
      path: "/admin/integration-hub/deliveries",
      icon: "list-checks",
      group: "integrations",
      order: 30,
      requiredPermission: "integration_hub.deliveries.read"
    }
  ],
  jobs: [
    {
      command: "bun run integration-hub:outbound:dispatch",
      purpose:
        "Claim/send/finalize due awcms_mini_integration_outbound_deliveries rows for every active tenant's active subscriptions, with SSRF-guarded delivery, retry/backoff, and dead-letter transitions.",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        "Real outbound network egress to each subscription's own target_url — the job itself always runs (pure PostgreSQL claim/finalize), but a target on the public internet requires connectivity; a LAN-only target works fully offline.",
      safeInOfflineLan: true
    }
  ],
  dataLifecycle: [
    {
      key: "integration_hub.inbound_deliveries",
      tableName: "awcms_mini_integration_inbound_deliveries",
      ownerModuleKey: "integration_hub",
      scope: "tenant",
      cursorColumn: "received_at",
      retentionClass: "communication_log",
      retentionMinDays: 7,
      retentionMaxDays: 365,
      defaultRetentionDays: 90,
      partition: {
        eligible: true,
        granularity: "monthly",
        rationale:
          "High-volume, append-only, time-ordered inbound webhook inbox — a natural monthly partition candidate once volume warrants it (not automated by this issue, guidance only)."
      },
      archive: {
        archivable: false,
        rationale:
          "Raw provider payload data minimization is the explicit goal (Issue #754) — this table intentionally stores only a bounded, redacted snippet already, not a full payload worth preserving in a separate archive artifact."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "No downstream FK references this table; safe to hard-delete once past retention."
      },
      legalHold: { applicable: true, precedence: "overrides_retention" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "received_at"],
          purpose:
            "Tenant-scoped cursor ordering for the generic archive/purge engine's bounded batches."
        }
      ],
      batchLimit: 2000,
      backupRestoreNotes:
        "Not restorable from a separate archive artifact (archive.archivable: false) — a full-database backup/restore is the only recovery path for this table, same as any other hard-deleted operational log.",
      executionMode: "generic"
    }
  ]
  // `awcms_mini_integration_outbound_deliveries`/`_delivery_attempts` are
  // deliberately NOT registered as data_lifecycle descriptors in this PR —
  // `_delivery_attempts.delivery_id` has a plain (non-CASCADE) foreign key
  // to `_outbound_deliveries.id`, and `_outbound_deliveries.replay_of_
  // delivery_id` self-references the same table; `data_lifecycle`'s
  // generic purge engine issues an unordered plain `DELETE FROM
  // <tableName>` per descriptor (`archive-purge-job.ts`, no cross-
  // descriptor FK-aware ordering) — registering both without first
  // confirming/adding delete ordering or `ON DELETE` semantics risks a
  // real foreign-key-violation purge failure. Follow-up issue, not
  // attempted here (documented limitation, README).
});
