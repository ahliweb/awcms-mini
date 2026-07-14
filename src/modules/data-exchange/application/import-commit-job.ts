/**
 * Asynchronous, idempotent, resumable commit pass (Issue #752 — the
 * module's core security requirement: "large imports never execute ... as
 * one unbounded database transaction", "a worker interruption and retry
 * do not duplicate committed rows"). Runs on the worker role, never
 * inline with an HTTP request — `requestImportCommit`
 * (`import-batch-directory.ts`) only flips the batch to `committing`; this
 * file does the actual per-row work, one BOUNDED pass at a time.
 *
 * Idempotency/resumability, precisely: each pass selects only
 * `awcms_mini_data_exchange_staged_rows` rows with `commit_status =
 * 'pending'`, in `row_number` order, up to `batchSize` at a time. A row
 * already marked `'committed'` (by THIS pass, an earlier pass, or a prior
 * worker invocation that crashed AFTER marking it but BEFORE the process
 * otherwise continuing) is never selected again — so re-running this
 * function after a crash/restart (`requestImportRetry`'s
 * `partially_committed | failed -> committing` transition) can only ever
 * process rows that were NOT already committed, never re-apply one that
 * was. The owning adapter's `commitRow` is ADDITIONALLY idempotent per
 * `naturalKey` (`reference-items-exchange-adapter.ts`'s own doc comment)
 * as defense-in-depth, for the narrower race where a row's real target
 * write succeeded but this function crashed BEFORE marking
 * `commit_status = 'committed'`.
 *
 * A RETRYABLE per-row failure (`DataExchangeCommitOutcome.retryable:
 * true`, e.g. a transient constraint race) stops the CURRENT pass
 * immediately WITHOUT marking that row `'failed'` (it stays `'pending'`,
 * picked up again on the batch's NEXT scheduled pass) — this deliberately
 * returns `count: <rows actually committed before the stall>` so the
 * bounded-batch loop (`runBoundedBatches`, `src/lib/jobs/batching.ts`)
 * treats a pass that made zero committed progress as "backlog drained for
 * THIS invocation" and defers to the next scheduled worker tick, rather
 * than hot-looping on the same stuck row within one invocation.
 */
import { log } from "../../../lib/logging/logger";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DATA_EXCHANGE_EVENT_VERSION,
  DATA_EXCHANGE_IMPORT_COMMITTED_EVENT_TYPE,
  DATA_EXCHANGE_IMPORT_FAILED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { resolveImportAdapter } from "../infrastructure/exchange-adapter-registry";
import {
  getImportBatchById,
  resolveImportDescriptor
} from "./import-batch-directory";
import {
  computeKeySetChecksum,
  recordReconciliation
} from "./reconciliation-service";

const MODULE_KEY = "data_exchange";

export type CommitPassOutcome = {
  count: number;
  finished: boolean;
  status: "committing" | "committed" | "partially_committed" | "failed";
};

type PendingStagedRow = {
  id: string;
  row_number: number;
  fields: Record<string, unknown>;
  natural_key: string | null;
  proposed_action: "create" | "update";
};

export async function runImportCommitPass(
  tx: Bun.SQL,
  tenantId: string,
  batchId: string,
  batchSize: number,
  correlationId?: string
): Promise<CommitPassOutcome> {
  const batch = await getImportBatchById(tx, tenantId, batchId);
  if (!batch || batch.status !== "committing") {
    return {
      count: 0,
      finished: true,
      status: batch?.status === "committed" ? "committed" : "failed"
    };
  }

  if (batch.pausedAt !== null) {
    return { count: 0, finished: true, status: "committing" };
  }

  const descriptor = resolveImportDescriptor(batch.importKey);
  const adapter = descriptor
    ? resolveImportAdapter(descriptor.adapterRegistryKey)
    : null;

  if (!descriptor || !adapter) {
    await tx`
      UPDATE awcms_mini_data_exchange_import_batches
      SET status = 'failed', error_summary = ${`Import descriptor or adapter for "${batch.importKey}" is no longer resolvable.`}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${batchId}
    `;
    await appendDomainEvent(tx, tenantId, {
      eventType: DATA_EXCHANGE_IMPORT_FAILED_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      aggregateType: "import_batch",
      aggregateId: batchId,
      producerModule: MODULE_KEY,
      correlationId,
      payload: { phase: "commit", reason: "adapter_unresolvable" }
    });
    return { count: 0, finished: true, status: "failed" };
  }

  const pendingRows = (await tx`
    SELECT id, row_number, fields, natural_key, proposed_action
    FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId} AND commit_status = 'pending'
    ORDER BY row_number ASC
    LIMIT ${batchSize}
  `) as PendingStagedRow[];

  let committedThisPass = 0;
  let highestRowNumberSeen = batch.commitCursor;

  for (const row of pendingRows) {
    const outcome = await adapter.commitRow(
      tx,
      tenantId,
      row.fields,
      row.proposed_action,
      row.natural_key ?? ""
    );

    if (outcome.committed) {
      await tx`
        UPDATE awcms_mini_data_exchange_staged_rows
        SET commit_status = 'committed', commit_resource_id = ${outcome.resourceId}, committed_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${row.id}
      `;
      committedThisPass += 1;
      highestRowNumberSeen = Math.max(highestRowNumberSeen, row.row_number);
      continue;
    }

    if (outcome.retryable) {
      // Stop this pass WITHOUT marking the row failed — see file header.
      break;
    }

    await tx`
      UPDATE awcms_mini_data_exchange_staged_rows
      SET commit_status = 'failed', commit_error = ${outcome.reason}
      WHERE tenant_id = ${tenantId} AND id = ${row.id}
    `;
    highestRowNumberSeen = Math.max(highestRowNumberSeen, row.row_number);
  }

  await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET commit_cursor = ${highestRowNumberSeen}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
  `;

  const remainingRows = (await tx`
    SELECT count(*)::int AS total
    FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId} AND commit_status = 'pending'
  `) as { total: number }[];

  if ((remainingRows[0]?.total ?? 0) > 0) {
    return { count: committedThisPass, finished: false, status: "committing" };
  }

  // Every staged row is now committed/failed/skipped — finalize the batch.
  const outcomeCounts = (await tx`
    SELECT commit_status, count(*)::int AS total
    FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId}
    GROUP BY commit_status
  `) as { commit_status: string; total: number }[];

  const byStatus = new Map<string, number>();
  for (const row of outcomeCounts) {
    byStatus.set(row.commit_status, row.total);
  }
  const failedCount = byStatus.get("failed") ?? 0;
  const finalStatus = failedCount > 0 ? "partially_committed" : "committed";

  const committedKeys = (await tx`
    SELECT natural_key FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId} AND commit_status = 'committed' AND natural_key IS NOT NULL
  `) as { natural_key: string }[];
  const intendedKeys = (await tx`
    SELECT natural_key FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${batchId}
      AND proposed_action IN ('create', 'update') AND natural_key IS NOT NULL
  `) as { natural_key: string }[];

  await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET status = ${finalStatus}, failed_count = ${failedCount}, committed_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId} AND status = 'committing'
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: DATA_EXCHANGE_IMPORT_COMMITTED_EVENT_TYPE,
    eventVersion: DATA_EXCHANGE_EVENT_VERSION,
    aggregateType: "import_batch",
    aggregateId: batchId,
    producerModule: MODULE_KEY,
    correlationId,
    payload: {
      status: finalStatus,
      committedCount: committedKeys.length,
      failedCount
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: MODULE_KEY,
    action: "post",
    resourceType: "import_batch",
    resourceId: batchId,
    severity: finalStatus === "committed" ? "info" : "warning",
    message: `Import batch "${batch.importKey}" commit finished: ${finalStatus} (${committedKeys.length} committed, ${failedCount} failed).`,
    attributes: {
      status: finalStatus,
      committedCount: committedKeys.length,
      failedCount
    },
    correlationId
  });

  await recordReconciliation(
    tx,
    tenantId,
    {
      subjectType: "import",
      subjectId: batchId,
      sourceCount: intendedKeys.length,
      processedCount: committedKeys.length,
      sourceChecksumSha256: computeKeySetChecksum(
        intendedKeys.map((row) => row.natural_key)
      ),
      processedChecksumSha256: computeKeySetChecksum(
        committedKeys.map((row) => row.natural_key)
      )
    },
    correlationId
  );

  log("info", "data_exchange.import.committed", {
    moduleKey: MODULE_KEY,
    batchId,
    status: finalStatus,
    committedCount: committedKeys.length,
    failedCount
  });

  return { count: committedThisPass, finished: true, status: finalStatus };
}
