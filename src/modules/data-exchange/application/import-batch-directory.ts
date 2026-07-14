/**
 * Import batch persistence + audit (Issue #752). Same "not-found/invalid-
 * state is a discriminated union, never a thrown error" convention
 * `organization-structure/application/legal-entity-directory.ts` documents.
 * Column list repeated literally at each query site (not factored into a
 * shared `sql.unsafe()` fragment) — same convention every other directory
 * module in this repo uses (`tenant-domain-directory.ts`'s own header).
 *
 * `stageImportBatch` is the ONLY write path for `awcms_mini_data_exchange_
 * import_batches` from the interactive (`awcms_mini_app`) request path —
 * everything after staging (parse/validate/commit) runs on the worker role
 * via `import-parse-validate-job.ts`/`import-commit-job.ts`.
 */
import { createHash } from "node:crypto";

import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DATA_EXCHANGE_EVENT_VERSION,
  DATA_EXCHANGE_IMPORT_STAGED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { listModules } from "../../index";
import type { ExchangeDescriptor } from "../../_shared/module-contract";
import { collectExchangeDescriptors } from "../domain/exchange-registry";
import { isAllowedMediaType } from "../domain/media-type-allowlist";
import { sanitizeDisplayFilename } from "../domain/safe-filename";
import {
  isImportBatchCancellable,
  isImportBatchRetryable,
  type ImportBatchStatus
} from "../domain/import-batch-state";

const MODULE_KEY = "data_exchange";

export type ImportBatchRow = {
  id: string;
  tenantId: string;
  importKey: string;
  format: "csv" | "json";
  status: ImportBatchStatus;
  originalFilename: string | null;
  byteSize: number;
  rowCount: number | null;
  checksumSha256: string;
  schemaVersion: string | null;
  commitCursor: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  conflictCount: number;
  invalidCount: number;
  failedCount: number;
  errorSummary: string | null;
  pausedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  validatedAt: Date | null;
  committedAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date;
};

type ImportBatchDbRow = {
  id: string;
  tenant_id: string;
  import_key: string;
  format: "csv" | "json";
  status: ImportBatchStatus;
  original_filename: string | null;
  byte_size: number;
  row_count: number | null;
  checksum_sha256: string;
  schema_version: string | null;
  commit_cursor: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  conflict_count: number;
  invalid_count: number;
  failed_count: number;
  error_summary: string | null;
  paused_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  validated_at: Date | null;
  committed_at: Date | null;
  cancelled_at: Date | null;
  expires_at: Date;
};

function toRow(row: ImportBatchDbRow): ImportBatchRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    importKey: row.import_key,
    format: row.format,
    status: row.status,
    originalFilename: row.original_filename,
    byteSize: Number(row.byte_size),
    rowCount: row.row_count === null ? null : Number(row.row_count),
    checksumSha256: row.checksum_sha256,
    schemaVersion: row.schema_version,
    commitCursor: Number(row.commit_cursor),
    createdCount: Number(row.created_count),
    updatedCount: Number(row.updated_count),
    skippedCount: Number(row.skipped_count),
    conflictCount: Number(row.conflict_count),
    invalidCount: Number(row.invalid_count),
    failedCount: Number(row.failed_count),
    errorSummary: row.error_summary,
    pausedAt: row.paused_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validatedAt: row.validated_at,
    committedAt: row.committed_at,
    cancelledAt: row.cancelled_at,
    expiresAt: row.expires_at
  };
}

/** Resolves an `ExchangeDescriptor` by key for the `import`/`both` direction — the same registry every owning module contributes to (`_shared/module-contract.ts`'s `dataExchange` field). */
export function resolveImportDescriptor(
  importKey: string
): ExchangeDescriptor | null {
  const descriptor = collectExchangeDescriptors(listModules()).find(
    (candidate) => candidate.key === importKey
  );

  if (!descriptor) {
    return null;
  }

  if (descriptor.direction !== "import" && descriptor.direction !== "both") {
    return null;
  }

  return descriptor;
}

export type StageImportBatchInput = {
  importKey: string;
  format: "csv" | "json";
  /** Client-declared `File.type`/Content-Type — checked against a per-format allow-list (Issue #752 acceptance criterion: media type is one of the enforced intake bounds). */
  mediaType: string;
  originalFilename: string | null;
  rawContent: string;
  clientChecksumSha256: string | null;
};

export type StageImportBatchResult =
  | { ok: true; batch: ImportBatchRow }
  | { ok: false; reason: "unknown_import_key" }
  | { ok: false; reason: "unsupported_format" }
  | { ok: false; reason: "unsupported_media_type" }
  | { ok: false; reason: "empty_file" }
  | { ok: false; reason: "file_too_large"; limitBytes: number }
  | { ok: false; reason: "checksum_mismatch" };

/**
 * Stages a new import batch. Performs NO parsing/validation of the file's
 * ROWS (that happens asynchronously, `import-parse-validate-job.ts`) —
 * this is intake only: descriptor resolution, format/media-type/size bound
 * checks (the byte-size cap here is a SECOND check on top of the HTTP
 * layer's own `readFormBody`/`readTextBody` cap, `src/lib/security/
 * request-body-limit.ts` — that cap is a fixed tier shared by every
 * endpoint; this one enforces the DESCRIPTOR's own, potentially smaller,
 * declared `limits.maxFileBytes`), server-side checksum computation, and
 * safe filename sanitization.
 */
export async function stageImportBatch(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: StageImportBatchInput,
  correlationId?: string
): Promise<StageImportBatchResult> {
  const descriptor = resolveImportDescriptor(input.importKey);
  if (!descriptor) {
    return { ok: false, reason: "unknown_import_key" };
  }

  if (!descriptor.formats.includes(input.format)) {
    return { ok: false, reason: "unsupported_format" };
  }

  if (!isAllowedMediaType(input.format, input.mediaType)) {
    return { ok: false, reason: "unsupported_media_type" };
  }

  if (input.rawContent.trim().length === 0) {
    return { ok: false, reason: "empty_file" };
  }

  const byteSize = Buffer.byteLength(input.rawContent, "utf8");
  if (byteSize > descriptor.limits.maxFileBytes) {
    return {
      ok: false,
      reason: "file_too_large",
      limitBytes: descriptor.limits.maxFileBytes
    };
  }

  const checksumSha256 = createHash("sha256")
    .update(input.rawContent)
    .digest("hex");

  if (
    input.clientChecksumSha256 !== null &&
    input.clientChecksumSha256 !== checksumSha256
  ) {
    return { ok: false, reason: "checksum_mismatch" };
  }

  const safeFilename = sanitizeDisplayFilename(input.originalFilename);

  const rows = (await tx`
    INSERT INTO awcms_mini_data_exchange_import_batches
      (tenant_id, import_key, format, original_filename, byte_size,
       checksum_sha256, client_checksum_sha256, schema_version, raw_content, created_by)
    VALUES (
      ${tenantId}, ${input.importKey}, ${input.format}, ${safeFilename}, ${byteSize},
      ${checksumSha256}, ${input.clientChecksumSha256}, ${descriptor.schemaVersion},
      ${input.rawContent}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
  `) as ImportBatchDbRow[];

  const batch = toRow(rows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: DATA_EXCHANGE_IMPORT_STAGED_EVENT_TYPE,
    eventVersion: DATA_EXCHANGE_EVENT_VERSION,
    aggregateType: "import_batch",
    aggregateId: batch.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      importKey: batch.importKey,
      format: batch.format,
      byteSize: batch.byteSize
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "import_batch",
    resourceId: batch.id,
    severity: "info",
    message: `Import batch staged for "${batch.importKey}" (${batch.byteSize} bytes).`,
    attributes: { importKey: batch.importKey, format: batch.format },
    correlationId
  });

  return { ok: true, batch };
}

export async function getImportBatchById(
  tx: Bun.SQL,
  tenantId: string,
  batchId: string
): Promise<ImportBatchRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
    FROM awcms_mini_data_exchange_import_batches
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
  `) as ImportBatchDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

/** Raw content is fetched SEPARATELY (never included in the ordinary row projection above) so a plain list/get call never accidentally pulls a potentially-large text blob into memory/response. */
export async function getImportBatchRawContent(
  tx: Bun.SQL,
  tenantId: string,
  batchId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT raw_content FROM awcms_mini_data_exchange_import_batches
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
  `) as { raw_content: string }[];

  return rows[0]?.raw_content ?? null;
}

export type ListImportBatchesFilter = {
  importKey?: string;
  status?: ImportBatchStatus;
};

/** Bounded list (`LIMIT 200`), newest first — same convention `listLegalEntities` establishes. */
export async function listImportBatches(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListImportBatchesFilter = {}
): Promise<ImportBatchRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
    FROM awcms_mini_data_exchange_import_batches
    WHERE tenant_id = ${tenantId}
      AND (${filter.importKey ?? null}::text IS NULL OR import_key = ${filter.importKey ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as ImportBatchDbRow[];

  return rows.map(toRow);
}

export type CancelImportBatchResult =
  | { ok: true; batch: ImportBatchRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_cancellable"; status: ImportBatchStatus };

export async function cancelImportBatch(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  batchId: string,
  reason: string,
  correlationId?: string
): Promise<CancelImportBatchResult> {
  const existing = await getImportBatchById(tx, tenantId, batchId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (!isImportBatchCancellable(existing.status)) {
    return { ok: false, reason: "not_cancellable", status: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${actorTenantUserId},
        cancel_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
      AND status IN ('staged', 'validating', 'previewed', 'failed')
    RETURNING id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
  `) as ImportBatchDbRow[];

  if (!rows[0]) {
    // Lost a race against the worker/another admin action.
    const latest = await getImportBatchById(tx, tenantId, batchId);
    return {
      ok: false,
      reason: "not_cancellable",
      status: latest?.status ?? existing.status
    };
  }

  const batch = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "cancel",
    resourceType: "import_batch",
    resourceId: batch.id,
    severity: "warning",
    message: `Import batch "${batch.importKey}" cancelled.`,
    attributes: { reason },
    correlationId
  });

  return { ok: true, batch };
}

export type SetImportBatchPausedResult =
  | { ok: true; batch: ImportBatchRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_state"; status: ImportBatchStatus };

/** `committing -> committing` (paused) — a batch can only be paused/resumed while its commit is genuinely in progress; a batch still being parsed/validated has nothing running long enough to need pausing (that phase is a single bounded pass). */
export async function pauseImportBatch(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  batchId: string,
  correlationId?: string
): Promise<SetImportBatchPausedResult> {
  const existing = await getImportBatchById(tx, tenantId, batchId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "committing") {
    return { ok: false, reason: "invalid_state", status: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET paused_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId} AND status = 'committing'
    RETURNING id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
  `) as ImportBatchDbRow[];

  if (!rows[0]) {
    const latest = await getImportBatchById(tx, tenantId, batchId);
    return {
      ok: false,
      reason: "invalid_state",
      status: latest?.status ?? existing.status
    };
  }

  const batch = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "manage",
    resourceType: "import_batch",
    resourceId: batch.id,
    severity: "info",
    message: `Import batch "${batch.importKey}" paused.`,
    attributes: { paused: true },
    correlationId
  });

  return { ok: true, batch };
}

export async function resumeImportBatch(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  batchId: string,
  correlationId?: string
): Promise<SetImportBatchPausedResult> {
  const existing = await getImportBatchById(tx, tenantId, batchId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "committing" || existing.pausedAt === null) {
    return { ok: false, reason: "invalid_state", status: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET paused_at = NULL, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId} AND status = 'committing'
    RETURNING id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
  `) as ImportBatchDbRow[];

  if (!rows[0]) {
    const latest = await getImportBatchById(tx, tenantId, batchId);
    return {
      ok: false,
      reason: "invalid_state",
      status: latest?.status ?? existing.status
    };
  }

  const batch = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "manage",
    resourceType: "import_batch",
    resourceId: batch.id,
    severity: "info",
    message: `Import batch "${batch.importKey}" resumed.`,
    attributes: { paused: false },
    correlationId
  });

  return { ok: true, batch };
}

export type RequestCommitResult =
  | { ok: true; batch: ImportBatchRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_ready"; status: ImportBatchStatus };

/** `previewed -> committing` — the explicit, separate trigger for the asynchronous commit (Issue #752: "explicit idempotent commit separate from preview; no mutation occurs during validation/preview"). Does NOT itself commit any row — it only flips the batch's status so the worker picks it up on its next pass. */
export async function requestImportCommit(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  batchId: string,
  correlationId?: string
): Promise<RequestCommitResult> {
  const existing = await getImportBatchById(tx, tenantId, batchId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "previewed") {
    return { ok: false, reason: "not_ready", status: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET status = 'committing', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId} AND status = 'previewed'
    RETURNING id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
  `) as ImportBatchDbRow[];

  if (!rows[0]) {
    const latest = await getImportBatchById(tx, tenantId, batchId);
    return {
      ok: false,
      reason: "not_ready",
      status: latest?.status ?? existing.status
    };
  }

  const batch = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "post",
    resourceType: "import_batch",
    resourceId: batch.id,
    severity: "warning",
    message: `Import batch "${batch.importKey}" commit requested.`,
    attributes: { rowCount: batch.rowCount },
    correlationId
  });

  return { ok: true, batch };
}

export type RequestRetryResult =
  | { ok: true; batch: ImportBatchRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_retryable"; status: ImportBatchStatus };

/** `partially_committed | failed -> committing` — resumes a previously-interrupted or partially-failed commit. Never re-applies an already-committed row: the commit job's own bounded pass only ever selects `commit_status = 'pending'` staged rows (Issue #752 acceptance criterion: "a worker interruption and retry do not duplicate committed rows"). */
export async function requestImportRetry(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  batchId: string,
  correlationId?: string
): Promise<RequestRetryResult> {
  const existing = await getImportBatchById(tx, tenantId, batchId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (!isImportBatchRetryable(existing.status)) {
    return { ok: false, reason: "not_retryable", status: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_import_batches
    SET status = 'committing', paused_at = NULL, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${batchId}
      AND status IN ('partially_committed', 'failed')
    RETURNING id, tenant_id, import_key, format, status, original_filename, byte_size,
      row_count, checksum_sha256, schema_version, commit_cursor, created_count, updated_count,
      skipped_count, conflict_count, invalid_count, failed_count, error_summary, paused_at,
      created_by, created_at, updated_at, validated_at, committed_at, cancelled_at, expires_at
  `) as ImportBatchDbRow[];

  if (!rows[0]) {
    const latest = await getImportBatchById(tx, tenantId, batchId);
    return {
      ok: false,
      reason: "not_retryable",
      status: latest?.status ?? existing.status
    };
  }

  const batch = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "retry",
    resourceType: "import_batch",
    resourceId: batch.id,
    severity: "warning",
    message: `Import batch "${batch.importKey}" commit retried/resumed from cursor ${batch.commitCursor}.`,
    attributes: { commitCursor: batch.commitCursor },
    correlationId
  });

  return { ok: true, batch };
}
