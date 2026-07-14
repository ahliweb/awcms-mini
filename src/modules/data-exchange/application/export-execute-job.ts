/**
 * Export job execution (Issue #752). Runs on the worker role. Reads
 * committed data through the owning module's `DataExchangeExportSourcePort`
 * (never a direct cross-module table read, ADR-0013 §6), paginates via
 * `fetchRowsPage` bounded by the descriptor's `limits.maxRowCount`, and
 * writes a manifest (schema/version/filters/row count/checksum/creation
 * metadata — Issue #752 acceptance criterion) plus the serialized file
 * content.
 *
 * Every string cell is run through `neutralizeFormulaInjectionValue`
 * (`formula-injection-guard.ts`) at serialization time — defense in depth,
 * independent of whether the source value passed through this module's
 * own import pipeline at all (Issue #752 security requirement:
 * "Spreadsheet-compatible exports neutralize formula prefixes where
 * applicable").
 */
import { createHash } from "node:crypto";

import { log } from "../../../lib/logging/logger";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DATA_EXCHANGE_EVENT_VERSION,
  DATA_EXCHANGE_EXPORT_COMPLETED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { neutralizeFormulaInjectionValue } from "../domain/formula-injection-guard";
import { serializeCsv } from "../domain/csv-codec";
import { serializeJson } from "../domain/json-codec";
import { resolveExportAdapter } from "../infrastructure/exchange-adapter-registry";
import {
  getExportJobById,
  resolveExportDescriptor
} from "./export-job-directory";
import {
  computeKeySetChecksum,
  recordReconciliation
} from "./reconciliation-service";

const MODULE_KEY = "data_exchange";
const EXPORT_PAGE_SIZE = 500;

export type ExportExecuteOutcome = {
  status: "completed" | "failed";
  rowCount: number;
};

/**
 * Reviewer finding on PR #782 (Low/hardening): a scalar-only check
 * (`typeof value === "string"`) misses a nested array/object field —
 * `serializeCsv`'s own call site below stringifies every non-string cell
 * via plain `String(value)`, and `String(["=1+1"])` evaluates to the bare
 * string `"=1+1"` (a single-element array's `toString()` just joins with
 * no brackets/quotes), which DOES begin with a dangerous character even
 * though the scalar-only check never inspected it. Fixed: compute the
 * SAME string CSV serialization will actually emit (`String(value)`) and
 * neutralize THAT — if it turns out dangerous, replace the value with the
 * neutralized STRING form (loses array/object structure, but that is the
 * safe direction); if safe, keep the original value untouched (preserves
 * array/object fidelity for JSON export, the common case).
 */
export function neutralizeRowForExport(
  row: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string") {
      output[key] = neutralizeFormulaInjectionValue(value).value;
      continue;
    }

    if (value === null || value === undefined || typeof value !== "object") {
      output[key] = value;
      continue;
    }

    const csvSerializedForm = String(value);
    const neutralized = neutralizeFormulaInjectionValue(csvSerializedForm);
    output[key] = neutralized.neutralized ? neutralized.value : value;
  }
  return output;
}

export async function runExportJob(
  tx: Bun.SQL,
  tenantId: string,
  jobId: string,
  correlationId?: string
): Promise<ExportExecuteOutcome | null> {
  const job = await getExportJobById(tx, tenantId, jobId);
  if (!job || job.status !== "queued") {
    return null;
  }

  await tx`
    UPDATE awcms_mini_data_exchange_export_jobs
    SET status = 'running'
    WHERE tenant_id = ${tenantId} AND id = ${jobId} AND status = 'queued'
  `;

  const descriptor = resolveExportDescriptor(job.exportKey);
  const adapter = descriptor
    ? resolveExportAdapter(descriptor.adapterRegistryKey)
    : null;

  if (!descriptor || !adapter) {
    await tx`
      UPDATE awcms_mini_data_exchange_export_jobs
      SET status = 'failed', error_summary = ${`Export descriptor or adapter for "${job.exportKey}" is no longer resolvable.`}
      WHERE tenant_id = ${tenantId} AND id = ${jobId}
    `;
    return { status: "failed", rowCount: 0 };
  }

  const sourceCount = await adapter.countRows(tx, tenantId, job.filterScope);

  if (sourceCount > descriptor.limits.maxRowCount) {
    await tx`
      UPDATE awcms_mini_data_exchange_export_jobs
      SET status = 'failed',
          error_summary = ${`Source row count (${sourceCount}) exceeds the descriptor's maxRowCount (${descriptor.limits.maxRowCount}).`}
      WHERE tenant_id = ${tenantId} AND id = ${jobId}
    `;
    return { status: "failed", rowCount: 0 };
  }

  const allRows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await adapter.fetchRowsPage(
      tx,
      tenantId,
      job.filterScope,
      cursor,
      EXPORT_PAGE_SIZE
    );
    for (const row of page.rows) {
      allRows.push(neutralizeRowForExport(row));
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }

  const content =
    job.format === "csv"
      ? serializeCsv(
          allRows.length > 0 ? Object.keys(allRows[0]!) : [],
          allRows.map((row) =>
            Object.values(row).map((value) =>
              value === null || value === undefined ? "" : String(value)
            )
          )
        )
      : serializeJson(allRows);

  const checksumSha256 = createHash("sha256").update(content).digest("hex");
  const manifest = {
    exportKey: job.exportKey,
    schemaVersion: descriptor.schemaVersion,
    format: job.format,
    filterScope: job.filterScope,
    rowCount: allRows.length,
    checksumSha256,
    createdAt: new Date().toISOString()
  };

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_export_jobs
    SET status = 'completed', row_count = ${allRows.length}, checksum_sha256 = ${checksumSha256},
        file_content = ${content}, manifest = ${manifest}, completed_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${jobId} AND status = 'running'
    RETURNING id
  `) as { id: string }[];

  if (!rows[0]) {
    return { status: "failed", rowCount: 0 };
  }

  await appendDomainEvent(tx, tenantId, {
    eventType: DATA_EXCHANGE_EXPORT_COMPLETED_EVENT_TYPE,
    eventVersion: DATA_EXCHANGE_EVENT_VERSION,
    aggregateType: "export_job",
    aggregateId: jobId,
    producerModule: MODULE_KEY,
    correlationId,
    payload: {
      exportKey: job.exportKey,
      rowCount: allRows.length,
      checksumSha256
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: MODULE_KEY,
    action: "export",
    resourceType: "export_job",
    resourceId: jobId,
    severity: "info",
    message: `Export job "${job.exportKey}" completed (${allRows.length} rows).`,
    attributes: { rowCount: allRows.length, checksumSha256 },
    correlationId
  });

  const rowKeys = allRows.map((row, index) =>
    typeof row.code === "string" ? row.code : String(index)
  );

  await recordReconciliation(
    tx,
    tenantId,
    {
      subjectType: "export",
      subjectId: jobId,
      sourceCount,
      processedCount: allRows.length,
      sourceChecksumSha256: null,
      processedChecksumSha256: computeKeySetChecksum(rowKeys)
    },
    correlationId
  );

  log("info", "data_exchange.export.completed", {
    moduleKey: MODULE_KEY,
    jobId,
    exportKey: job.exportKey,
    rowCount: allRows.length
  });

  return { status: "completed", rowCount: allRows.length };
}
