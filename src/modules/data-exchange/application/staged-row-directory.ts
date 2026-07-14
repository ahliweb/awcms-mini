/**
 * Staged row reads for the preview surface (Issue #752). Write access to
 * `awcms_mini_data_exchange_staged_rows` lives in `import-parse-validate-
 * job.ts`/`import-commit-job.ts` (worker role only) — this file is
 * read-only, consumed by the interactive `GET .../imports/{id}/preview`
 * endpoint.
 */

export type StagedRowRow = {
  id: string;
  importBatchId: string;
  rowNumber: number;
  fields: Record<string, unknown>;
  naturalKey: string | null;
  proposedAction: "create" | "update" | "skip" | "conflict" | "invalid" | null;
  validationErrors: { field: string; message: string }[] | null;
  validationWarnings: string[] | null;
  commitStatus: "pending" | "committed" | "failed" | "skipped";
  commitResourceId: string | null;
  commitError: string | null;
  committedAt: Date | null;
};

type StagedRowDbRow = {
  id: string;
  import_batch_id: string;
  row_number: number;
  fields: Record<string, unknown>;
  natural_key: string | null;
  proposed_action: StagedRowRow["proposedAction"];
  validation_errors: StagedRowRow["validationErrors"];
  validation_warnings: StagedRowRow["validationWarnings"];
  commit_status: StagedRowRow["commitStatus"];
  commit_resource_id: string | null;
  commit_error: string | null;
  committed_at: Date | null;
};

function toRow(row: StagedRowDbRow): StagedRowRow {
  return {
    id: row.id,
    importBatchId: row.import_batch_id,
    rowNumber: Number(row.row_number),
    fields: row.fields,
    naturalKey: row.natural_key,
    proposedAction: row.proposed_action,
    validationErrors: row.validation_errors,
    validationWarnings: row.validation_warnings,
    commitStatus: row.commit_status,
    commitResourceId: row.commit_resource_id,
    commitError: row.commit_error,
    committedAt: row.committed_at
  };
}

export const PREVIEW_PAGE_SIZE_DEFAULT = 50;
export const PREVIEW_PAGE_SIZE_MAX = 200;

export type ListStagedRowsFilter = {
  proposedAction?: StagedRowRow["proposedAction"];
  offset: number;
  limit: number;
};

export async function listStagedRows(
  tx: Bun.SQL,
  tenantId: string,
  importBatchId: string,
  filter: ListStagedRowsFilter
): Promise<StagedRowRow[]> {
  const rows = (await tx`
    SELECT id, import_batch_id, row_number, fields, natural_key, proposed_action,
      validation_errors, validation_warnings, commit_status, commit_resource_id,
      commit_error, committed_at
    FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${importBatchId}
      AND (${filter.proposedAction ?? null}::text IS NULL OR proposed_action = ${filter.proposedAction ?? null})
    ORDER BY row_number ASC
    OFFSET ${filter.offset}
    LIMIT ${filter.limit}
  `) as StagedRowDbRow[];

  return rows.map(toRow);
}

export async function countStagedRows(
  tx: Bun.SQL,
  tenantId: string,
  importBatchId: string,
  proposedAction?: StagedRowRow["proposedAction"]
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS total
    FROM awcms_mini_data_exchange_staged_rows
    WHERE tenant_id = ${tenantId} AND import_batch_id = ${importBatchId}
      AND (${proposedAction ?? null}::text IS NULL OR proposed_action = ${proposedAction ?? null})
  `) as { total: number }[];

  return rows[0]?.total ?? 0;
}

const REDACTED_VALUE = "[REDACTED]";

/**
 * Masks any field named in `sensitiveFieldNames` — Issue #752 security
 * requirement: "Preview/error artifacts minimize and mask PII; raw
 * invalid values require explicit permission". Applied to a row's
 * `fields` only (never to `naturalKey`, which is assumed non-sensitive —
 * it is also displayed as the row's identity in every preview list).
 */
export function maskSensitiveFields(
  row: StagedRowRow,
  sensitiveFieldNames: readonly string[]
): StagedRowRow {
  if (sensitiveFieldNames.length === 0) {
    return row;
  }

  const maskedFields: Record<string, unknown> = { ...row.fields };
  for (const fieldName of sensitiveFieldNames) {
    if (fieldName in maskedFields) {
      maskedFields[fieldName] = REDACTED_VALUE;
    }
  }

  return { ...row, fields: maskedFields };
}
