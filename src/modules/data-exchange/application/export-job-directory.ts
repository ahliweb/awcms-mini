/**
 * Export job persistence + audit (Issue #752). Same conventions as
 * `import-batch-directory.ts` — column list repeated literally per query,
 * discriminated-union results instead of thrown errors.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { listModules } from "../../index";
import type { ExchangeDescriptor } from "../../_shared/module-contract";
import { collectExchangeDescriptors } from "../domain/exchange-registry";
import {
  isExportJobCancellable,
  isExportJobRetryable,
  type ExportJobStatus
} from "../domain/export-job-state";

const MODULE_KEY = "data_exchange";

export type ExportJobRow = {
  id: string;
  tenantId: string;
  exportKey: string;
  format: "csv" | "json";
  status: ExportJobStatus;
  filterScope: Record<string, unknown>;
  schemaVersion: string | null;
  rowCount: number | null;
  checksumSha256: string | null;
  manifest: Record<string, unknown> | null;
  errorSummary: string | null;
  createdBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date;
};

type ExportJobDbRow = {
  id: string;
  tenant_id: string;
  export_key: string;
  format: "csv" | "json";
  status: ExportJobStatus;
  filter_scope: Record<string, unknown>;
  schema_version: string | null;
  row_count: number | null;
  checksum_sha256: string | null;
  manifest: Record<string, unknown> | null;
  error_summary: string | null;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  expires_at: Date;
};

function toRow(row: ExportJobDbRow): ExportJobRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    exportKey: row.export_key,
    format: row.format,
    status: row.status,
    filterScope: row.filter_scope ?? {},
    schemaVersion: row.schema_version,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    checksumSha256: row.checksum_sha256,
    manifest: row.manifest,
    errorSummary: row.error_summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    expiresAt: row.expires_at
  };
}

export function resolveExportDescriptor(
  exportKey: string
): ExchangeDescriptor | null {
  const descriptor = collectExchangeDescriptors(listModules()).find(
    (candidate) => candidate.key === exportKey
  );

  if (!descriptor) {
    return null;
  }

  if (descriptor.direction !== "export" && descriptor.direction !== "both") {
    return null;
  }

  return descriptor;
}

export type CreateExportJobInput = {
  exportKey: string;
  format: "csv" | "json";
  filterScope: Record<string, unknown>;
};

export type CreateExportJobResult =
  | { ok: true; job: ExportJobRow }
  | { ok: false; reason: "unknown_export_key" }
  | { ok: false; reason: "unsupported_format" };

export async function createExportJob(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateExportJobInput,
  correlationId?: string
): Promise<CreateExportJobResult> {
  const descriptor = resolveExportDescriptor(input.exportKey);
  if (!descriptor) {
    return { ok: false, reason: "unknown_export_key" };
  }
  if (!descriptor.formats.includes(input.format)) {
    return { ok: false, reason: "unsupported_format" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_data_exchange_export_jobs
      (tenant_id, export_key, format, filter_scope, schema_version, created_by)
    VALUES (
      ${tenantId}, ${input.exportKey}, ${input.format}, ${input.filterScope}, ${descriptor.schemaVersion}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, export_key, format, status, filter_scope, schema_version,
      row_count, checksum_sha256, manifest, error_summary, created_by, created_at,
      completed_at, cancelled_at, expires_at
  `) as ExportJobDbRow[];

  const job = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "export_job",
    resourceId: job.id,
    severity: "info",
    message: `Export job queued for "${job.exportKey}".`,
    attributes: { exportKey: job.exportKey, format: job.format },
    correlationId
  });

  return { ok: true, job };
}

export async function getExportJobById(
  tx: Bun.SQL,
  tenantId: string,
  jobId: string
): Promise<ExportJobRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, export_key, format, status, filter_scope, schema_version,
      row_count, checksum_sha256, manifest, error_summary, created_by, created_at,
      completed_at, cancelled_at, expires_at
    FROM awcms_mini_data_exchange_export_jobs
    WHERE tenant_id = ${tenantId} AND id = ${jobId}
  `) as ExportJobDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export async function getExportJobFileContent(
  tx: Bun.SQL,
  tenantId: string,
  jobId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT file_content FROM awcms_mini_data_exchange_export_jobs
    WHERE tenant_id = ${tenantId} AND id = ${jobId}
  `) as { file_content: string | null }[];

  return rows[0]?.file_content ?? null;
}

export type ListExportJobsFilter = {
  exportKey?: string;
  status?: ExportJobStatus;
};

export async function listExportJobs(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListExportJobsFilter = {}
): Promise<ExportJobRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, export_key, format, status, filter_scope, schema_version,
      row_count, checksum_sha256, manifest, error_summary, created_by, created_at,
      completed_at, cancelled_at, expires_at
    FROM awcms_mini_data_exchange_export_jobs
    WHERE tenant_id = ${tenantId}
      AND (${filter.exportKey ?? null}::text IS NULL OR export_key = ${filter.exportKey ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as ExportJobDbRow[];

  return rows.map(toRow);
}

export type CancelExportJobResult =
  | { ok: true; job: ExportJobRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_cancellable"; status: ExportJobStatus };

export async function cancelExportJob(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  jobId: string,
  correlationId?: string
): Promise<CancelExportJobResult> {
  const existing = await getExportJobById(tx, tenantId, jobId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (!isExportJobCancellable(existing.status)) {
    return { ok: false, reason: "not_cancellable", status: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_export_jobs
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${jobId} AND status IN ('queued', 'running')
    RETURNING id, tenant_id, export_key, format, status, filter_scope, schema_version,
      row_count, checksum_sha256, manifest, error_summary, created_by, created_at,
      completed_at, cancelled_at, expires_at
  `) as ExportJobDbRow[];

  if (!rows[0]) {
    const latest = await getExportJobById(tx, tenantId, jobId);
    return {
      ok: false,
      reason: "not_cancellable",
      status: latest?.status ?? existing.status
    };
  }

  const job = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "cancel",
    resourceType: "export_job",
    resourceId: job.id,
    severity: "warning",
    message: `Export job "${job.exportKey}" cancelled.`,
    attributes: {},
    correlationId
  });

  return { ok: true, job };
}

export function isExportRetryable(status: ExportJobStatus): boolean {
  return isExportJobRetryable(status);
}
