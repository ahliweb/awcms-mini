/**
 * Provider-neutral, cross-MODULE capability port (Issue #752, epic #738
 * platform-evolution Wave 3, ADR-0017 — ADR-0011 "port" sense, same shape
 * as `business-scope-hierarchy-port.ts`/`news-media-port.ts`). The generic
 * `data_exchange` engine (staging, bounded parse, preview, async idempotent
 * commit, export, reconciliation) never writes to another module's tables
 * directly (ADR-0013 §6 "no shared-table write") — every owning module that
 * wants staged import/export support implements ONE of these per import/
 * export contract, in its OWN `application/*-data-exchange-adapter.ts`
 * (mirroring `organization-structure-hierarchy-port-adapter.ts`'s exact
 * shape), and registers it under a stable string key in `data_exchange/
 * infrastructure/exchange-adapter-registry.ts` (a static, reviewed-source-
 * code registry — same pattern as `domain-event-runtime/infrastructure/
 * consumer-registry.ts`'s `DOMAIN_EVENT_CONSUMERS`).
 *
 * `ExchangeDescriptor` (`_shared/module-contract.ts`) is the PURE-DATA
 * counterpart declared alongside a module's REAL adapter — the descriptor
 * names limits/formats/schema version/permission; this port is the
 * EXECUTABLE contract the descriptor's `adapterRegistryKey` resolves to.
 *
 * This repo's own `data_exchange` module ships exactly ONE self-contained
 * reference implementation (`reference_items`, `data-exchange/application/
 * reference-items-exchange-adapter.ts`) to prove the mechanism end-to-end
 * (create/update/conflict, partial-failure/resume, export/reconciliation)
 * — mirroring the accepted "foundation issue ships zero real business
 * integrations" precedent (#742). Real owning modules implement and
 * register their OWN adapter when they start using this mechanism.
 */

/** A single parsed source record's field map — CSV columns or JSON object keys, values already string/number/boolean/null (never nested arrays/objects for CSV; JSON may nest). Values that looked like a spreadsheet formula prefix (`=`/`+`/`-`/`@`/TAB/CR) have ALREADY been neutralized (leading `'` inserted) by `data_exchange`'s own intake parser before an adapter ever sees them — see `domain/formula-injection-guard.ts`. */
export type DataExchangeFieldMap = Record<string, unknown>;

export type DataExchangeProposedAction =
  "create" | "update" | "skip" | "conflict";

export type DataExchangeFieldError = {
  field: string;
  message: string;
};

export type DataExchangeValidationResult =
  | {
      valid: true;
      /** The row's fields, normalized to the owning module's expected shape/types (e.g. trimmed strings, parsed numbers) — this is what gets persisted to `awcms_mini_data_exchange_staged_rows.fields` and later handed to `commitRow`. */
      normalizedFields: DataExchangeFieldMap;
      proposedAction: DataExchangeProposedAction;
      /** A stable identity for this row within the owning module's domain (e.g. a natural/business key) — used for (a) duplicate-within-batch detection, (b) `conflict` classification against existing data, and (c) the commit job's per-row idempotency tracking on resume. Must be deterministic given the same normalized fields. */
      naturalKey: string;
      warnings?: string[];
    }
  | {
      valid: false;
      errors: DataExchangeFieldError[];
    };

export type DataExchangeCommitOutcome =
  | {
      committed: true;
      /** The owning module's resource id that was created/updated/skipped — opaque to `data_exchange`, only ever stored/returned, never interpreted. */
      resourceId: string;
      action: "created" | "updated" | "skipped";
    }
  | {
      committed: false;
      /** `true` if the SAME row can be safely retried on a future commit pass (e.g. a transient constraint race) — `false` for a genuine data error that requires operator intervention (surfaced in the batch's error summary, not silently retried forever). */
      retryable: boolean;
      reason: string;
    };

/**
 * One owning module's import contract. `validateRow` MUST NOT mutate
 * anything (called only during the async parse/validate/preview phase,
 * inside a read-only-in-spirit transaction — `data_exchange` does not
 * enforce this at the type level, but a validator that writes violates the
 * issue's "no domain mutation during validation/preview" requirement).
 *
 * `commitRow` MUST be idempotent per `(tenantId, naturalKey)`: the commit
 * job may call it more than once for the same logical row across a
 * worker-restart/resume (Issue #752's "a worker interruption and retry do
 * not duplicate committed rows" acceptance criterion) — an adapter
 * implementation typically achieves this with an `INSERT ... ON CONFLICT
 * (tenant_id, <natural key column>) DO UPDATE`/`DO NOTHING` on its own
 * table, the same idiom `saveIdempotencyRecord` (`_shared/idempotency.ts`)
 * already uses for HTTP-level idempotency.
 */
export type DataExchangeAdapterPort = {
  /** Must equal the `ExchangeDescriptor.key` this adapter implements. */
  importKey: string;
  schemaVersion: string;
  validateRow(
    tx: Bun.SQL,
    tenantId: string,
    row: DataExchangeFieldMap
  ): Promise<DataExchangeValidationResult>;
  commitRow(
    tx: Bun.SQL,
    tenantId: string,
    row: DataExchangeFieldMap,
    proposedAction: DataExchangeProposedAction,
    naturalKey: string
  ): Promise<DataExchangeCommitOutcome>;
};

export type DataExchangeExportPage = {
  rows: readonly DataExchangeFieldMap[];
  /** Opaque keyset cursor for the next page, or `null` when this was the last page — same keyset-pagination shape doc 16 mandates for every list endpoint in this repo, applied here to export row streaming. */
  nextCursor: string | null;
};

/**
 * One owning module's export contract. `filterScope` is an opaque,
 * owning-module-defined JSON object (e.g. `{ status: "active" }`) —
 * `data_exchange` never interprets it, only stores it verbatim in the
 * export job's manifest for reconciliation/audit.
 */
export type DataExchangeExportSourcePort = {
  /** Must equal the `ExchangeDescriptor.key` this adapter implements. */
  exportKey: string;
  schemaVersion: string;
  countRows(
    tx: Bun.SQL,
    tenantId: string,
    filterScope: Record<string, unknown>
  ): Promise<number>;
  fetchRowsPage(
    tx: Bun.SQL,
    tenantId: string,
    filterScope: Record<string, unknown>,
    afterCursor: string | null,
    limit: number
  ): Promise<DataExchangeExportPage>;
};
