/**
 * Per-tenant worker orchestration (Issue #752) — one BOUNDED pass across
 * every phase (validate, commit, export) for a single tenant, called
 * repeatedly by `runBoundedBatches`/`iterateTenantsInBatches`
 * (`src/lib/jobs/batching.ts`) from `scripts/data-exchange-worker.ts`.
 * Same "count -> keep looping, 0 -> backlog drained" contract every other
 * migrated job in this repo uses.
 *
 * Reviewer finding on PR #782 (High): an earlier version of this file
 * wrapped ALL of a tenant's due work — up to 10 validate-pass batches (500
 * rows each) + up to 10 commit-pass batches (200 rows each) + up to 10
 * export jobs (up to `maxRowCount` rows each) — inside ONE `withTenant`
 * transaction, directly contradicting Issue #752's own requirement ("Large
 * imports never execute ... as one unbounded database transaction") and
 * this file's own (at the time, false) doc comment claiming otherwise.
 * Fixed: EVERY unit of work (each batch's validate pass, each batch's
 * commit pass, each export job, and even the three small ID-listing
 * queries) now opens its OWN `withTenant` call — matching every other
 * dispatcher in this repo (`email-dispatch.ts`, `object-dispatch.ts`,
 * `social-publish-dispatch.ts`), all of which open a fresh transaction PER
 * item. An uncaught exception in ONE item's transaction now only rolls
 * back THAT item's own work, never any unrelated batch/job processed
 * earlier or later in the same pass.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { runImportValidatePass } from "./import-parse-validate-job";
import { runImportCommitPass } from "./import-commit-job";
import { runExportJob } from "./export-execute-job";

const VALIDATE_BATCH_SIZE = 500;
const COMMIT_BATCH_SIZE = 200;
const WORKER_WORK_CLASS = "background_sync" as const;

export type DataExchangeWorkerPassResult = {
  count: number;
  validated: number;
  committed: number;
  exported: number;
};

/** Column list/WHERE spelled out literally per query — same convention every directory module in this repo uses (`import-batch-directory.ts`'s own header); no `tx.unsafe()` fragment composition. */
async function listStagedOrValidatingBatchIds(
  sql: Bun.SQL,
  tenantId: string
): Promise<string[]> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT id FROM awcms_mini_data_exchange_import_batches
        WHERE tenant_id = ${tenantId} AND status IN ('staged', 'validating')
        ORDER BY created_at ASC
        LIMIT 10
      `) as { id: string }[];

      return rows.map((row) => row.id);
    },
    { workClass: WORKER_WORK_CLASS }
  );
}

async function listUnpausedCommittingBatchIds(
  sql: Bun.SQL,
  tenantId: string
): Promise<string[]> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT id FROM awcms_mini_data_exchange_import_batches
        WHERE tenant_id = ${tenantId} AND status = 'committing' AND paused_at IS NULL
        ORDER BY created_at ASC
        LIMIT 10
      `) as { id: string }[];

      return rows.map((row) => row.id);
    },
    { workClass: WORKER_WORK_CLASS }
  );
}

async function listQueuedExportJobIds(
  sql: Bun.SQL,
  tenantId: string
): Promise<string[]> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT id FROM awcms_mini_data_exchange_export_jobs
        WHERE tenant_id = ${tenantId} AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT 10
      `) as { id: string }[];

      return rows.map((row) => row.id);
    },
    { workClass: WORKER_WORK_CLASS }
  );
}

/**
 * One bounded pass for ONE tenant: processes up to a handful of staged
 * batches' validate work, up to a handful of committing batches' commit
 * work, and up to a handful of queued export jobs. EVERY item below opens
 * its OWN `withTenant` transaction — never one transaction spanning
 * multiple unrelated batches/jobs (see this file's own header).
 */
export async function runDataExchangeWorkerPassForTenant(
  sql: Bun.SQL,
  tenantId: string,
  correlationId?: string
): Promise<DataExchangeWorkerPassResult> {
  let validated = 0;
  let committed = 0;
  let exported = 0;

  const stagedBatchIds = await listStagedOrValidatingBatchIds(sql, tenantId);

  for (const batchId of stagedBatchIds) {
    const outcome = await withTenant(
      sql,
      tenantId,
      (tx) =>
        runImportValidatePass(
          tx,
          tenantId,
          batchId,
          VALIDATE_BATCH_SIZE,
          correlationId
        ),
      { workClass: WORKER_WORK_CLASS }
    );
    validated += outcome.count;
  }

  const committingBatchIds = await listUnpausedCommittingBatchIds(
    sql,
    tenantId
  );

  for (const batchId of committingBatchIds) {
    const outcome = await withTenant(
      sql,
      tenantId,
      (tx) =>
        runImportCommitPass(
          tx,
          tenantId,
          batchId,
          COMMIT_BATCH_SIZE,
          correlationId
        ),
      { workClass: WORKER_WORK_CLASS }
    );
    committed += outcome.count;
  }

  const queuedExportJobIds = await listQueuedExportJobIds(sql, tenantId);

  for (const jobId of queuedExportJobIds) {
    const outcome = await withTenant(
      sql,
      tenantId,
      (tx) => runExportJob(tx, tenantId, jobId, correlationId),
      { workClass: WORKER_WORK_CLASS }
    );
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
}
