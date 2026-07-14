/**
 * Asynchronous parse/validate/preview pass (Issue #752). Runs on the
 * worker role (`bun run data-exchange:worker`), never inline with the
 * stage-upload HTTP request (that endpoint only calls `stageImportBatch`,
 * which does zero row-level parsing).
 *
 * BOUNDED, resumable, chunked across multiple passes (Issue #752 security
 * requirement: "large imports never execute ... as one unbounded database
 * transaction"): `raw_content` is bounded (≤ the descriptor's own
 * `limits.maxFileBytes`, itself ≤ the HTTP-layer hard ceiling), so
 * re-parsing it on every pass is cheap and safe — only the per-row
 * VALIDATE + INSERT work (which does real DB I/O per row, via the owning
 * adapter's `validateRow`) is chunked, `validate_cursor` rows at a time,
 * via `import_batches.validate_cursor` — never one unbounded transaction
 * for an entire large file.
 *
 * Every string field value is run through
 * `neutralizeFormulaInjectionInFields` BEFORE it is ever persisted to
 * `awcms_mini_data_exchange_staged_rows` (Issue #752 formula-injection
 * requirement) and BEFORE the owning adapter's `validateRow` ever sees it
 * — an adapter can trust that a leading `=`/`+`/`-`/`@`/TAB/CR is already
 * neutralized (prefixed with `'`).
 *
 * Performs NO domain mutation (Issue #752: "preview performs no domain
 * mutation") — `validateRow` is a read-only contract; only THIS module's
 * own `staged_rows`/`import_batches` tables are written here.
 */
import { log } from "../../../lib/logging/logger";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DATA_EXCHANGE_EVENT_VERSION,
  DATA_EXCHANGE_IMPORT_FAILED_EVENT_TYPE,
  DATA_EXCHANGE_IMPORT_PREVIEWED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  ExchangeIntakeLimitExceededError,
  parseCsvBounded
} from "../domain/csv-codec";
import { parseJsonBounded } from "../domain/json-codec";
import { neutralizeFormulaInjectionInFields } from "../domain/formula-injection-guard";
import { resolveImportAdapter } from "../infrastructure/exchange-adapter-registry";
import {
  getImportBatchById,
  getImportBatchRawContent,
  resolveImportDescriptor
} from "./import-batch-directory";

const MODULE_KEY = "data_exchange";

export type ParseValidatePassOutcome = {
  count: number;
  finished: boolean;
  status: "validating" | "previewed" | "failed";
};

async function markBatchFailed(
  tx: Bun.SQL,
  tenantId: string,
  batchId: string,
  errorSummary: string,
  correlationId?: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET status = 'failed', error_summary = ${errorSummary}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: DATA_EXCHANGE_IMPORT_FAILED_EVENT_TYPE,
    eventVersion: DATA_EXCHANGE_EVENT_VERSION,
    aggregateType: "import_batch",
    aggregateId: batchId,
    producerModule: MODULE_KEY,
    correlationId,
    payload: { errorSummary, phase: "validate" }
  });

  log("warning", "data_exchange.import.validate_failed", {
    moduleKey: MODULE_KEY,
    batchId,
    errorSummary
  });
}

type ParsedRow = Record<string, unknown>;

function parseRawContent(
  format: "csv" | "json",
  rawContent: string,
  maxRowCount: number,
  maxFieldsPerRow: number
): { ok: true; rows: ParsedRow[] } | { ok: false; error: string } {
  if (format === "csv") {
    const parsed = parseCsvBounded(rawContent, {
      maxRowCount,
      maxFieldsPerRow
    });
    const header = parsed.header;
    const rows = parsed.rows.map((cells) => {
      const row: ParsedRow = {};
      header.forEach((column, index) => {
        row[column] = cells[index] ?? null;
      });
      return row;
    });
    return { ok: true, rows };
  }

  const result = parseJsonBounded(rawContent, { maxRowCount, maxFieldsPerRow });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, rows: [...result.document.rows] };
}

/**
 * Runs ONE bounded pass for a single batch. The FIRST pass for a batch
 * transitions `staged -> validating`; the LAST pass (once
 * `validate_cursor` reaches the parsed row total) transitions
 * `validating -> previewed` (or `-> failed` on a structural parse error)
 * and computes final aggregate counts. Callers (`data-exchange-worker.ts`)
 * loop this via `runBoundedBatches` until `finished` is `true`.
 */
export async function runImportValidatePass(
  tx: Bun.SQL,
  tenantId: string,
  batchId: string,
  batchSize: number,
  correlationId?: string
): Promise<ParseValidatePassOutcome> {
  const batch = await getImportBatchById(tx, tenantId, batchId);
  if (!batch || (batch.status !== "staged" && batch.status !== "validating")) {
    return { count: 0, finished: true, status: "previewed" };
  }

  if (batch.status === "staged") {
    await tx`
      UPDATE awcms_mini_data_exchange_import_batches
      SET status = 'validating', updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${batchId} AND status = 'staged'
    `;
  }

  const descriptor = resolveImportDescriptor(batch.importKey);
  const adapter = descriptor
    ? resolveImportAdapter(descriptor.adapterRegistryKey)
    : null;

  if (!descriptor || !adapter) {
    await markBatchFailed(
      tx,
      tenantId,
      batchId,
      `Import descriptor or adapter for "${batch.importKey}" is no longer resolvable.`,
      correlationId
    );
    return { count: 0, finished: true, status: "failed" };
  }

  const rawContent = await getImportBatchRawContent(tx, tenantId, batchId);
  if (rawContent === null) {
    await markBatchFailed(
      tx,
      tenantId,
      batchId,
      "Staged raw content is missing.",
      correlationId
    );
    return { count: 0, finished: true, status: "failed" };
  }

  let parsedRows: ParsedRow[];
  try {
    const parseResult = parseRawContent(
      batch.format,
      rawContent,
      descriptor.limits.maxRowCount,
      descriptor.limits.maxFieldsPerRow
    );
    if (!parseResult.ok) {
      await markBatchFailed(
        tx,
        tenantId,
        batchId,
        parseResult.error,
        correlationId
      );
      return { count: 0, finished: true, status: "failed" };
    }
    parsedRows = parseResult.rows;
  } catch (error) {
    if (error instanceof ExchangeIntakeLimitExceededError) {
      await markBatchFailed(
        tx,
        tenantId,
        batchId,
        error.message,
        correlationId
      );
      return { count: 0, finished: true, status: "failed" };
    }
    throw error;
  }

  // `validate_cursor` is not projected by `getImportBatchById` — re-read here.
  const cursorRows = (await tx`
    SELECT validate_cursor FROM awcms_mini_data_exchange_import_batches
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
  `) as { validate_cursor: number }[];
  const cursor = cursorRows[0]?.validate_cursor ?? 0;
  const sliceStart = Math.min(cursor, parsedRows.length);
  const sliceEnd = Math.min(sliceStart + batchSize, parsedRows.length);
  const slice = parsedRows.slice(sliceStart, sliceEnd);

  let processedInThisPass = 0;

  for (let offset = 0; offset < slice.length; offset += 1) {
    const rowNumber = sliceStart + offset + 1;
    const rawRow = slice[offset]!;
    const { fields: neutralizedFields } =
      neutralizeFormulaInjectionInFields(rawRow);
    const validation = await adapter.validateRow(
      tx,
      tenantId,
      neutralizedFields
    );

    if (!validation.valid) {
      await tx`
        INSERT INTO awcms_mini_data_exchange_staged_rows
          (tenant_id, import_batch_id, row_number, fields, proposed_action, validation_errors, commit_status)
        VALUES (
          ${tenantId}, ${batchId}, ${rowNumber}, ${neutralizedFields}, 'invalid',
          ${JSON.stringify(validation.errors)}::jsonb, 'skipped'
        )
        ON CONFLICT (tenant_id, import_batch_id, row_number) DO NOTHING
      `;
    } else {
      const commitStatus =
        validation.proposedAction === "create" ||
        validation.proposedAction === "update"
          ? "pending"
          : "skipped";

      await tx`
        INSERT INTO awcms_mini_data_exchange_staged_rows
          (tenant_id, import_batch_id, row_number, fields, natural_key, proposed_action, validation_warnings, commit_status)
        VALUES (
          ${tenantId}, ${batchId}, ${rowNumber}, ${validation.normalizedFields}, ${validation.naturalKey},
          ${validation.proposedAction}, ${JSON.stringify(validation.warnings ?? [])}::jsonb, ${commitStatus}
        )
        ON CONFLICT (tenant_id, import_batch_id, row_number) DO NOTHING
      `;
    }

    processedInThisPass += 1;
  }

  const newCursor = sliceEnd;
  await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET validate_cursor = ${newCursor}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
  `;

  if (newCursor < parsedRows.length) {
    return {
      count: processedInThisPass,
      finished: false,
      status: "validating"
    };
  }

  const aggregateRows = (await tx`
    SELECT proposed_action, count(*)::int AS total
    FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId}
    GROUP BY proposed_action
  `) as { proposed_action: string | null; total: number }[];

  const countsByAction = new Map<string, number>();
  for (const row of aggregateRows) {
    countsByAction.set(row.proposed_action ?? "invalid", row.total);
  }

  const createdCount = countsByAction.get("create") ?? 0;
  const updatedCount = countsByAction.get("update") ?? 0;
  const skippedCount = countsByAction.get("skip") ?? 0;
  const conflictCount = countsByAction.get("conflict") ?? 0;
  const invalidCount = countsByAction.get("invalid") ?? 0;

  await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET status = 'previewed', row_count = ${parsedRows.length},
        created_count = ${createdCount}, updated_count = ${updatedCount},
        skipped_count = ${skippedCount}, conflict_count = ${conflictCount},
        invalid_count = ${invalidCount}, validated_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId} AND status = 'validating'
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: DATA_EXCHANGE_IMPORT_PREVIEWED_EVENT_TYPE,
    eventVersion: DATA_EXCHANGE_EVENT_VERSION,
    aggregateType: "import_batch",
    aggregateId: batchId,
    producerModule: MODULE_KEY,
    correlationId,
    payload: {
      rowCount: parsedRows.length,
      createdCount,
      updatedCount,
      skippedCount,
      conflictCount,
      invalidCount
    }
  });

  log("info", "data_exchange.import.previewed", {
    moduleKey: MODULE_KEY,
    batchId,
    rowCount: parsedRows.length,
    createdCount,
    updatedCount,
    skippedCount,
    conflictCount,
    invalidCount
  });

  return { count: processedInThisPass, finished: true, status: "previewed" };
}
