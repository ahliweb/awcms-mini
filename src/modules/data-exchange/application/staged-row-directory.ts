/**
 * Staged row reads for the preview surface (Issue #752). Write access to
 * `awcms_mini_data_exchange_staged_rows` lives in `import-parse-validate-
 * job.ts`/`import-commit-job.ts` (worker role only) — this file is
 * read-only, consumed by the interactive `GET .../imports/{id}/preview`
 * endpoint.
 */
import { MAX_EXCHANGE_ROW_COUNT } from "../domain/exchange-registry";

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

/**
 * Hard ceiling on the preview's `OFFSET` (Issue #831). `limit` was already
 * clamped one line below its parse site in the route, but `offset` was only
 * checked `>= 0` — `?offset=5000000` reached Postgres verbatim, forcing it
 * to walk and discard five million `staged_rows` per request. This table is
 * unlike the base's log-shaped tables: a single 100k-row CSV import fills it
 * to deep-offset volume in one shot, so the ceiling is not theoretical.
 *
 * Derived from `MAX_EXCHANGE_ROW_COUNT` — the registry gate caps every
 * descriptor's `limits.maxRowCount` at that value, so no batch can hold a
 * row at this offset in the first place. The ceiling therefore hides no
 * reachable row, and stays correct if that cap is ever raised.
 */
export const PREVIEW_OFFSET_MAX = MAX_EXCHANGE_ROW_COUNT;

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
 * Masks any field named in `policy.fieldNames` — Issue #752 security
 * requirement: "Preview/error artifacts minimize and mask PII; raw invalid
 * values require explicit permission".
 *
 * `naturalKey` is masked too when `policy.naturalKeyField` names a field
 * that is itself sensitive (Issue #820 Cacat 4). This function previously
 * masked `fields` only, on the stated ASSUMPTION that `naturalKey` was
 * non-sensitive — an assumption, never an invariant, and the wrong way
 * round for the very adapters this base exists to host: a profile import's
 * dedup key IS the email/NIK. Masking the `fields` copy while echoing the
 * same value back as `naturalKey` would have masked nothing at all.
 *
 * `validationWarnings` and `commitError` are dropped for that same reason
 * (PR #839 security review). Both are FREE TEXT produced by the owning
 * module's adapter — a warning like `"email x@y.com is already registered"`,
 * or an `outcome.reason` quoting the offending value — so both are channels
 * the masked value comes straight back through. `maskAllFields` already
 * dropped `validationWarnings` on exactly this reasoning ("a warning is free
 * text an adapter may have interpolated a raw value into"); that reasoning
 * was always equally true here, and `commitError` was kept on BOTH paths.
 * `validationErrors` stay: they carry a field name plus a fixed message, not
 * a value.
 */
export function maskSensitiveFields(
  row: StagedRowRow,
  policy: { fieldNames: readonly string[]; naturalKeyField?: string }
): StagedRowRow {
  if (policy.fieldNames.length === 0) {
    return row;
  }

  const maskedFields: Record<string, unknown> = { ...row.fields };
  for (const fieldName of policy.fieldNames) {
    if (fieldName in maskedFields) {
      maskedFields[fieldName] = REDACTED_VALUE;
    }
  }

  const naturalKeyIsSensitive =
    policy.naturalKeyField !== undefined &&
    policy.fieldNames.includes(policy.naturalKeyField);

  return {
    ...row,
    fields: maskedFields,
    naturalKey:
      naturalKeyIsSensitive && row.naturalKey !== null
        ? REDACTED_VALUE
        : row.naturalKey,
    validationWarnings: row.validationWarnings === null ? null : [],
    commitError: row.commitError === null ? null : REDACTED_VALUE
  };
}

/**
 * Default-deny projection (Issue #820 Cacat 1): redacts EVERY field value
 * plus `naturalKey`, keeping only the row's non-content metadata (row
 * number, proposed action, commit status). Used when a descriptor declares
 * no `sensitiveFields` policy at all — the base cannot know which of that
 * descriptor's fields are safe, and an unknown field is treated as
 * sensitive, never as safe. No permission unmasks this; the owning module
 * must declare its policy (the registry gate rejects a descriptor without
 * one, so this is defence in depth for a descriptor reaching the route by
 * some other path).
 *
 * `validationErrors` are kept — they carry a field name and a message, not
 * a value — but `validationWarnings` and `commitError` are dropped, since
 * both are free text an adapter may have interpolated a raw value into
 * (`commitError` is the adapter's own `outcome.reason`). `commitError`
 * becomes the redaction marker rather than `null` so the row still reports
 * THAT it failed, just not with what value (PR #839 security review: it was
 * previously passed through verbatim even on this default-deny path).
 */
export function maskAllFields(row: StagedRowRow): StagedRowRow {
  const maskedFields: Record<string, unknown> = {};
  for (const fieldName of Object.keys(row.fields)) {
    maskedFields[fieldName] = REDACTED_VALUE;
  }

  return {
    ...row,
    fields: maskedFields,
    naturalKey: row.naturalKey === null ? null : REDACTED_VALUE,
    validationWarnings: row.validationWarnings === null ? null : [],
    commitError: row.commitError === null ? null : REDACTED_VALUE
  };
}
