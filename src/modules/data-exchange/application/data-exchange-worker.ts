/**
 * Per-tenant worker orchestration (Issue #752) — one BOUNDED pass across
 * every phase (validate, commit, export) for a single tenant, called
 * repeatedly by `runBoundedBatches`/`iterateTenantsInBatches`
 * (`src/lib/jobs/batching.ts`) from `scripts/data-exchange-worker.ts`.
 * Same "count -> keep looping, 0 -> backlog drained" contract every other
 * migrated job in this repo uses.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { runImportValidatePass } from "./import-parse-validate-job";
import { runImportCommitPass } from "./import-commit-job";
import { runExportJob } from "./export-execute-job";

const VALIDATE_BATCH_SIZE = 500;
const COMMIT_BATCH_SIZE = 200;

export type DataExchangeWorkerPassResult = {
  count: number;
  validated: number;
  committed: number;
  exported: number;
};

/**
 * One bounded pass for ONE tenant: processes up to a handful of staged
 * batches' validate work, up to a handful of committing batches' commit
 * work, and up to a handful of queued export jobs — all within
 * `withTenant`'s own connection/transaction-per-call discipline (each
 * sub-call below opens its OWN transaction via the `tx` this function
 * already received from the caller's `withTenant`, so a single pass here
 * is itself one transaction boundary per unit of work, never one giant
 * transaction spanning every batch).
 */
export async function runDataExchangeWorkerPassForTenant(
  sql: Bun.SQL,
  tenantId: string,
  correlationId?: string
): Promise<DataExchangeWorkerPassResult> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      let validated = 0;
      let committed = 0;
      let exported = 0;

      const stagedBatchIds = (await tx`
      SELECT id FROM awcms_mini_data_exchange_import_batches
      WHERE tenant_id = ${tenantId} AND status IN ('staged', 'validating')
      ORDER BY created_at ASC
      LIMIT 10
    `) as { id: string }[];

      for (const { id: batchId } of stagedBatchIds) {
        const outcome = await runImportValidatePass(
          tx,
          tenantId,
          batchId,
          VALIDATE_BATCH_SIZE,
          correlationId
        );
        validated += outcome.count;
      }

      const committingBatchIds = (await tx`
      SELECT id FROM awcms_mini_data_exchange_import_batches
      WHERE tenant_id = ${tenantId} AND status = 'committing' AND paused_at IS NULL
      ORDER BY created_at ASC
      LIMIT 10
    `) as { id: string }[];

      for (const { id: batchId } of committingBatchIds) {
        const outcome = await runImportCommitPass(
          tx,
          tenantId,
          batchId,
          COMMIT_BATCH_SIZE,
          correlationId
        );
        committed += outcome.count;
      }

      const queuedExportJobIds = (await tx`
      SELECT id FROM awcms_mini_data_exchange_export_jobs
      WHERE tenant_id = ${tenantId} AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 10
    `) as { id: string }[];

      for (const { id: jobId } of queuedExportJobIds) {
        const outcome = await runExportJob(tx, tenantId, jobId, correlationId);
        if (outcome && outcome.status === "completed") {
          exported += 1;
        }
      }

      return {
        count: validated + committed + exported,
        validated,
        committed,
        exported
      };
    },
    { workClass: "background_sync" }
  );
}
