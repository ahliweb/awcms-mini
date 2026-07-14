/**
 * Reconciliation report persistence (Issue #752 acceptance criterion:
 * "reconciliation can detect a deliberate mismatch"). Wraps the pure
 * comparison (`domain/reconciliation.ts`) with the DB write + domain
 * event/audit for a genuine mismatch — called by both
 * `import-commit-job.ts` (after a batch finishes committing) and
 * `export-execute-job.ts` (after an export job completes).
 */
import { createHash } from "node:crypto";

import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DATA_EXCHANGE_EVENT_VERSION,
  DATA_EXCHANGE_RECONCILIATION_MISMATCH_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { evaluateReconciliation } from "../domain/reconciliation";

const MODULE_KEY = "data_exchange";

/** Deterministic checksum over a set of natural keys/identifiers — sorted before hashing so key ORDER never affects the result (only membership does). Used as a cheap, generic "did the same set of records participate" signal when neither side has a richer content checksum available. */
export function computeKeySetChecksum(keys: readonly string[]): string {
  const sorted = [...keys].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export type RecordReconciliationInput = {
  subjectType: "import" | "export";
  subjectId: string;
  sourceCount: number;
  processedCount: number;
  sourceChecksumSha256: string | null;
  processedChecksumSha256: string | null;
};

export type ReconciliationReportRow = {
  id: string;
  tenantId: string;
  subjectType: "import" | "export";
  subjectId: string;
  sourceCount: number;
  processedCount: number;
  mismatch: boolean;
  details: string;
  createdAt: Date;
};

export async function recordReconciliation(
  tx: Bun.SQL,
  tenantId: string,
  input: RecordReconciliationInput,
  correlationId?: string
): Promise<ReconciliationReportRow> {
  const verdict = evaluateReconciliation({
    sourceCount: input.sourceCount,
    processedCount: input.processedCount,
    sourceChecksumSha256: input.sourceChecksumSha256,
    processedChecksumSha256: input.processedChecksumSha256
  });

  const rows = (await tx`
    INSERT INTO awcms_mini_data_exchange_reconciliation_reports
      (tenant_id, subject_type, subject_id, source_count, processed_count,
       source_checksum_sha256, processed_checksum_sha256, mismatch, details)
    VALUES (
      ${tenantId}, ${input.subjectType}, ${input.subjectId}, ${input.sourceCount}, ${input.processedCount},
      ${input.sourceChecksumSha256}, ${input.processedChecksumSha256}, ${verdict.mismatch}, ${verdict.details}
    )
    RETURNING id, tenant_id, subject_type, subject_id, source_count, processed_count, mismatch, details, created_at
  `) as {
    id: string;
    tenant_id: string;
    subject_type: "import" | "export";
    subject_id: string;
    source_count: number;
    processed_count: number;
    mismatch: boolean;
    details: string;
    created_at: Date;
  }[];

  const report = rows[0]!;

  if (verdict.mismatch) {
    await appendDomainEvent(tx, tenantId, {
      eventType: DATA_EXCHANGE_RECONCILIATION_MISMATCH_EVENT_TYPE,
      eventVersion: DATA_EXCHANGE_EVENT_VERSION,
      aggregateType: input.subjectType,
      aggregateId: input.subjectId,
      producerModule: MODULE_KEY,
      correlationId,
      payload: {
        subjectType: input.subjectType,
        sourceCount: input.sourceCount,
        processedCount: input.processedCount,
        countMismatch: verdict.countMismatch,
        checksumMismatch: verdict.checksumMismatch
      }
    });

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: MODULE_KEY,
      action: "read",
      resourceType: "reconciliation_report",
      resourceId: report.id,
      severity: "warning",
      message: `Reconciliation mismatch detected for ${input.subjectType} ${input.subjectId}: ${verdict.details}`,
      attributes: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        sourceCount: input.sourceCount,
        processedCount: input.processedCount
      },
      correlationId
    });
  }

  return {
    id: report.id,
    tenantId: report.tenant_id,
    subjectType: report.subject_type,
    subjectId: report.subject_id,
    sourceCount: Number(report.source_count),
    processedCount: Number(report.processed_count),
    mismatch: report.mismatch,
    details: report.details,
    createdAt: report.created_at
  };
}

/** Bounded list (`LIMIT 100`), newest first, for one subject. */
export async function listReconciliationReports(
  tx: Bun.SQL,
  tenantId: string,
  subjectType: "import" | "export",
  subjectId: string
): Promise<ReconciliationReportRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, subject_type, subject_id, source_count, processed_count, mismatch, details, created_at
    FROM awcms_mini_data_exchange_reconciliation_reports
    WHERE tenant_id = ${tenantId} AND subject_type = ${subjectType} AND subject_id = ${subjectId}
    ORDER BY created_at DESC
    LIMIT 100
  `) as {
    id: string;
    tenant_id: string;
    subject_type: "import" | "export";
    subject_id: string;
    source_count: number;
    processed_count: number;
    mismatch: boolean;
    details: string;
    created_at: Date;
  }[];

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    sourceCount: Number(row.source_count),
    processedCount: Number(row.processed_count),
    mismatch: row.mismatch,
    details: row.details,
    createdAt: row.created_at
  }));
}
