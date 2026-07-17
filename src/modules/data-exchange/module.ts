import { defineModule } from "../_shared/module-contract";

/**
 * `data_exchange` (Issue #752, epic `platform-evolution` #738, Wave 3,
 * ADR-0018 — Official Optional Module, "Official Optional Business
 * Foundation" per ADR-0013 §3, `type: "domain"`).
 *
 * Provider-neutral staged CSV/JSON import/export framework: staged
 * upload/intake (checksum + safe filename metadata, no external object
 * storage dependency), bounded asynchronous parse/validate/preview,
 * preview with no domain mutation, an explicit asynchronous IDEMPOTENT
 * commit (never a long-running HTTP request, never an unbounded
 * transaction — the shared worker runner, `bun run data-exchange:worker`),
 * resumable partial-failure handling (per-row commit cursor), export jobs
 * with manifest/checksum, and reconciliation (source vs processed count/
 * checksum comparison). Every OWNING module supplies its own schema/
 * validation/mapping/commit adapter via a capability port
 * (`DataExchangeAdapterPort`, `_shared/ports/data-exchange-adapter-port.ts`)
 * and a pure-data descriptor (`ExchangeDescriptor`,
 * `_shared/module-contract.ts`'s `dataExchange` field) — this module NEVER
 * writes to another module's tables directly (ADR-0013 §6).
 *
 * Ships exactly ONE self-contained reference descriptor pair
 * (`reference_items`, `application/reference-items-exchange-adapter.ts`)
 * to prove create/update/conflict, partial-failure/resume, and export/
 * reconciliation end-to-end — real owning-module adapters are a follow-up
 * (ADR-0018 §10, mirrors the accepted "foundation issue ships zero real
 * business integrations" precedent from `domain_event_runtime`, #742).
 *
 * Formula-injection (CSV injection) neutralization is applied at BOTH
 * intake parse time and export serialization time — see
 * `domain/formula-injection-guard.ts`.
 */
export const dataExchangeModule = defineModule({
  key: "data_exchange",
  name: "Data Exchange",
  version: "0.1.0",
  status: "active",
  description:
    "Provider-neutral staged CSV/JSON import/export framework (Issue #752, epic #738 platform-evolution Wave 3, ADR-0018): module-contributed exchange descriptors, staged intake (checksum + safe filename, size/row/field-bounded parsing with formula-injection neutralization), preview with zero domain mutation, asynchronous idempotent resumable commit via the shared worker runner, export jobs with manifest/checksum, and reconciliation. Each owning module supplies its own schema/validation/mapping/commit adapter through a capability port; this module never writes to another module's tables directly. Ships one self-contained reference fixture (reference_items) to prove the mechanism end-to-end.",
  dependencies: [
    "tenant_admin",
    "identity_access",
    "logging",
    "domain_event_runtime"
  ],
  type: "domain",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/data-exchange"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.data-exchange.import.staged",
      "awcms-mini.data-exchange.import.previewed",
      "awcms-mini.data-exchange.import.committed",
      "awcms-mini.data-exchange.import.failed",
      "awcms-mini.data-exchange.export.completed",
      "awcms-mini.data-exchange.reconciliation.mismatch"
    ]
  },
  navigation: [
    {
      labelKey: "admin.data_exchange.nav.imports",
      path: "/admin/data-exchange/imports",
      icon: "upload",
      order: 10,
      group: "data_exchange",
      requiredPermission: "data_exchange.imports.read"
    },
    {
      labelKey: "admin.data_exchange.nav.exports",
      path: "/admin/data-exchange/exports",
      icon: "download",
      order: 20,
      group: "data_exchange",
      requiredPermission: "data_exchange.exports.read"
    }
  ],
  permissions: [
    {
      activityCode: "descriptors",
      action: "read",
      description:
        "Read the module-contributed exchange descriptor registry (code-declared metadata only)"
    },
    {
      activityCode: "imports",
      action: "read",
      description:
        "Read/list staged import batches and their preview (masked values only)"
    },
    {
      activityCode: "imports",
      action: "create",
      description:
        "Stage a new import batch (upload file, checksum/media-type verified)"
    },
    {
      activityCode: "imports",
      action: "post",
      description:
        "Trigger the asynchronous idempotent commit of a previewed import batch"
    },
    {
      activityCode: "imports",
      action: "cancel",
      description: "Cancel a staged import batch before commit begins"
    },
    {
      activityCode: "imports",
      action: "retry",
      description: "Retry/resume a partially-committed or failed import batch"
    },
    {
      activityCode: "imports",
      action: "manage",
      description: "Pause or resume an in-progress import batch"
    },
    {
      activityCode: "preview_errors",
      action: "read",
      description:
        "Read raw (unmasked) invalid-row values in an import batch preview"
    },
    {
      activityCode: "exports",
      action: "read",
      description: "Read/list export jobs and their manifest"
    },
    {
      activityCode: "exports",
      action: "create",
      description: "Trigger a new export job"
    },
    {
      activityCode: "exports",
      action: "cancel",
      description: "Cancel a queued or running export job"
    },
    {
      activityCode: "export_downloads",
      action: "read",
      description: "Download an export job's file content"
    },
    {
      activityCode: "reconciliation",
      action: "read",
      description: "Read reconciliation reports for an import or export subject"
    }
  ],
  jobs: [
    {
      command: "bun run data-exchange:worker",
      purpose:
        "Parse/validate staged import batches, commit previewed batches in bounded per-row passes (resumable via commit_cursor), execute queued export jobs, and record reconciliation reports — for every active tenant.",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        "Pure PostgreSQL/in-process operation — no external network egress, no object storage provider required. Safe in offline/LAN deployments.",
      safeInOfflineLan: true
    }
  ],
  capabilities: {
    provides: ["data_exchange_staging"]
  },
  dataLifecycle: [
    {
      key: "data_exchange.import_batches",
      tableName: "awcms_mini_data_exchange_import_batches",
      ownerModuleKey: "data_exchange",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "operational_queue",
      retentionMinDays: 7,
      retentionMaxDays: 365,
      defaultRetentionDays: 30,
      partition: {
        eligible: false,
        rationale:
          "Expected volume (one row per staged upload) is orders of magnitude below partition-justifying scale; native PostgreSQL partitioning is not justified until real volume evidence says otherwise (same restraint data_lifecycle's own descriptors apply)."
      },
      archive: {
        archivable: true,
        format: "jsonl",
        port: "local_offline",
        rationale:
          "A staged import's raw content and outcome counts are worth preserving as evidence beyond the live retention window (what was imported, when, by whom) at negligible cost given the table's moderate expected volume."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "raw_content may contain an owning module's business data (potentially including PII depending on the import) — archived first (evidence preserved under legal hold if applicable), then hard-deleted from the live table rather than retained indefinitely."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "status", "created_at"],
          purpose:
            "Worker scan for staged/committing batches, newest first; also the cursor index for generic lifecycle execution."
        },
        {
          columns: ["tenant_id", "expires_at"],
          purpose: "Expiry-driven purge/backlog scan."
        }
      ],
      batchLimit: 2000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore (docs/awcms-mini/resilience-dr-verification.md); archived rows additionally have a standalone JSONL artifact. `awcms_mini_data_exchange_staged_rows` cascade-deletes with its parent batch (ON DELETE CASCADE) — not registered as its own descriptor.",
      executionMode: "generic"
    },
    {
      key: "data_exchange.export_jobs",
      tableName: "awcms_mini_data_exchange_export_jobs",
      ownerModuleKey: "data_exchange",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "operational_queue",
      retentionMinDays: 7,
      retentionMaxDays: 365,
      defaultRetentionDays: 30,
      partition: {
        eligible: false,
        rationale:
          "Expected volume (one row per triggered export) is orders of magnitude below partition-justifying scale."
      },
      archive: {
        archivable: true,
        format: "jsonl",
        port: "local_offline",
        rationale:
          "An export job's manifest/checksum and (while retained) file content are evidence of what was exported and when."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "file_content is a snapshot of already-committed owning-module data — archived first, then hard-deleted from the live table rather than retained indefinitely."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "status", "created_at"],
          purpose:
            "Worker scan for queued export jobs, newest first; also the cursor index for generic lifecycle execution."
        },
        {
          columns: ["tenant_id", "expires_at"],
          purpose: "Expiry-driven purge/backlog scan."
        }
      ],
      batchLimit: 2000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; archived rows additionally have a standalone JSONL artifact.",
      executionMode: "generic"
    },
    {
      key: "data_exchange.reconciliation_reports",
      tableName: "awcms_mini_data_exchange_reconciliation_reports",
      ownerModuleKey: "data_exchange",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "operational_queue",
      retentionMinDays: 30,
      retentionMaxDays: 1825,
      defaultRetentionDays: 180,
      partition: {
        eligible: false,
        rationale:
          "Expected volume (one row per completed commit pass or export job) is small relative to partition-justifying scale."
      },
      archive: {
        archivable: true,
        format: "jsonl",
        port: "local_offline",
        rationale:
          "Reconciliation reports are retention/purge-adjacent EVIDENCE themselves (what was reconciled, when, mismatch or not) — archiving before physical delete preserves that evidence beyond the live retention window, same reasoning data_lifecycle's own run-history descriptor documents."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "No PII beyond opaque UUIDs already scoped by RLS plus aggregate counts/checksums — anonymization has nothing further to remove."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "subject_type", "subject_id", "created_at"],
          purpose: "Per-subject reconciliation history lookup, newest first."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; archived rows additionally have a standalone JSONL artifact.",
      executionMode: "generic"
    }
  ],
  dataExchange: [
    {
      key: "data_exchange.reference_items",
      ownerModuleKey: "data_exchange",
      direction: "both",
      formats: ["csv", "json"],
      schemaVersion: "1.0",
      limits: {
        maxFileBytes: 5 * 1024 * 1024,
        maxRowCount: 5000,
        maxFieldsPerRow: 10
      },
      adapterRegistryKey: "reference_items",
      // Affirmatively non-sensitive (Issue #820): this fixture's fields are
      // synthetic code/label/value/status rows carrying no identifier, and
      // `naturalKey` is its `code`. Declared explicitly rather than omitted
      // — omission is now a registry-gate error, not a silent "show all".
      sensitiveFields: { fieldNames: [], naturalKeyField: "code" },
      description:
        "Self-contained reference fixture (generic tenant-scoped code/label/value/status rows, awcms_mini_data_exchange_reference_items) proving the staging/validate/preview/commit/export/reconciliation mechanism end-to-end. Not a real business domain — see this module's README."
    }
  ]
});
