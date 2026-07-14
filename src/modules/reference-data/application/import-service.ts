/**
 * Validated reference-data import pipeline (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021 §8/§11). Dry-run is NON-MUTATING
 * against `awcms_mini_reference_codes` (it only ever writes an
 * `awcms_mini_reference_imports` row) — commit re-runs the FULL
 * validation (`domain/import-diff.ts`'s `computeImportDiff`) INSIDE the
 * SAME transaction as the write, against a FRESH read of "referenced"
 * state, never trusting the earlier dry-run's snapshot alone (issue #750:
 * "trace validated import backward from the real commit path", and the
 * accumulated-defect note this epic's prior PRs left behind about
 * validators that exist but are unwired on the real write path).
 *
 * `awcms_mini_reference_codes.code` is unique per value set FOREVER (the
 * DB constraint is NOT partial on `deprecated_at IS NULL`, migration
 * 066) — a deprecated code's string is retired, never recycled for a
 * different meaning (issue #750: "never repurposed in place"). So the
 * "existing managed" set a payload is diffed against is EVERY
 * `provenance = 'import'` code for the value set, deprecated or not — a
 * code reappearing in a later payload after being deprecated by an
 * earlier one is treated as an update that also clears its deprecation
 * (the source is asserting it is valid again), never a fresh insert that
 * would collide with the unique constraint.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { computeRequestHash } from "../../_shared/idempotency";
import {
  REFERENCE_DATA_EVENT_VERSION,
  REFERENCE_DATA_IMPORT_COMMITTED_EVENT_TYPE,
  REFERENCE_DATA_IMPORT_ROLLED_BACK_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  computeImportDiff,
  validateImportPayloadShape,
  type ImportDiffExistingCode,
  type ImportDiffPayloadCode,
  type ImportPayloadValidationError
} from "../domain/import-diff";

const MODULE_KEY = "reference_data";

export type ReferenceImportRow = {
  id: string;
  valueSetId: string;
  status: "validated" | "rejected" | "committed" | "rolled_back";
  sourceProvenance: string | null;
  payload: { codes: ImportDiffPayloadCode[] };
  checksum: string;
  diffSummary: Record<string, unknown>;
  rejectionReason: string | null;
  createdAt: Date;
};

type ImportDbRow = {
  id: string;
  value_set_id: string;
  status: ReferenceImportRow["status"];
  source_provenance: string | null;
  payload: { codes: ImportDiffPayloadCode[] };
  checksum: string;
  diff_summary: Record<string, unknown>;
  rejection_reason: string | null;
  created_at: Date;
};

function toRow(row: ImportDbRow): ReferenceImportRow {
  return {
    id: row.id,
    valueSetId: row.value_set_id,
    status: row.status,
    sourceProvenance: row.source_provenance,
    payload: row.payload,
    checksum: row.checksum,
    diffSummary: row.diff_summary,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at
  };
}

type ExistingCodeDbRow = {
  id: string;
  code: string;
  referenced: boolean;
};

async function fetchExistingManagedCodes(
  tx: Bun.SQL,
  valueSetId: string
): Promise<(ImportDiffExistingCode & { id: string })[]> {
  const rows = (await tx`
    SELECT rc.id, rc.code,
      EXISTS(
        SELECT 1 FROM awcms_mini_reference_tenant_codes tc WHERE tc.base_code_id = rc.id
      ) AS referenced
    FROM awcms_mini_reference_codes rc
    WHERE rc.value_set_id = ${valueSetId} AND rc.provenance = 'import'
  `) as ExistingCodeDbRow[];
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    referenced: row.referenced
  }));
}

export type DryRunImportResult =
  | {
      ok: true;
      import: ReferenceImportRow;
      diff: {
        toCreate: string[];
        toUpdate: string[];
        toDeprecate: string[];
        blockedReplacements: string[];
      };
    }
  | { ok: false; reason: "validation"; errors: ImportPayloadValidationError[] };

export async function dryRunReferenceImport(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  valueSetId: string,
  input: { codes: ImportDiffPayloadCode[]; sourceProvenance: string | null },
  correlationId?: string
): Promise<DryRunImportResult> {
  const shapeErrors = validateImportPayloadShape(input.codes);
  if (shapeErrors.length > 0) {
    return { ok: false, reason: "validation", errors: shapeErrors };
  }

  const existing = await fetchExistingManagedCodes(tx, valueSetId);
  const diff = computeImportDiff(existing, input.codes);
  const checksum = computeRequestHash(input.codes);

  const diffSummary = {
    toCreate: diff.toCreate.map((entry) => entry.code),
    toUpdate: diff.toUpdate.map((entry) => entry.code),
    toDeprecate: diff.toDeprecate,
    blockedReplacements: diff.blockedReplacements
  };

  const rows = (await tx`
    INSERT INTO awcms_mini_reference_imports
      (value_set_id, status, source_provenance, payload, checksum, diff_summary,
       rejection_reason, created_by)
    VALUES (
      ${valueSetId}, ${diff.ok ? "validated" : "rejected"}, ${input.sourceProvenance},
      ${{ codes: input.codes }}, ${checksum}, ${diffSummary},
      ${diff.ok ? null : `Blocked destructive replacement of referenced code(s): ${diff.blockedReplacements.join(", ")}`},
      ${actorTenantUserId}
    )
    RETURNING id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
  `) as ImportDbRow[];

  const importRow = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "reference_import",
    resourceId: importRow.id,
    severity: diff.ok ? "info" : "warning",
    message: diff.ok
      ? `Reference import dry-run for value set produced a valid diff (create=${diffSummary.toCreate.length}, update=${diffSummary.toUpdate.length}, deprecate=${diffSummary.toDeprecate.length}).`
      : `Reference import dry-run REJECTED — destructive replacement of referenced code(s): ${diff.blockedReplacements.join(", ")}.`,
    attributes: { valueSetId, ...diffSummary },
    correlationId
  });

  return { ok: true, import: importRow, diff: diffSummary };
}

export type CommitImportResult =
  | { ok: true; import: ReferenceImportRow }
  | { ok: false; reason: "not_found" }
  | {
      ok: false;
      reason: "invalid_status";
      status: ReferenceImportRow["status"];
    }
  | { ok: false; reason: "checksum_mismatch" }
  | {
      ok: false;
      reason: "blocked_by_referenced_codes";
      blockedCodes: string[];
    };

export async function commitReferenceImport(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  importId: string,
  expectedChecksum: string,
  correlationId?: string
): Promise<CommitImportResult> {
  const rows = (await tx`
    SELECT id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
    FROM awcms_mini_reference_imports
    WHERE id = ${importId}
    FOR UPDATE
  `) as ImportDbRow[];

  const existingImport = rows[0];
  if (!existingImport) {
    return { ok: false, reason: "not_found" };
  }
  if (existingImport.status !== "validated") {
    return {
      ok: false,
      reason: "invalid_status",
      status: existingImport.status
    };
  }
  if (existingImport.checksum !== expectedChecksum) {
    return { ok: false, reason: "checksum_mismatch" };
  }

  // Re-validate for REAL, inside this transaction, against a FRESH read —
  // never trust the dry-run's diff_summary alone (issue #750 requirement,
  // this file's own header comment).
  const existingManaged = await fetchExistingManagedCodes(
    tx,
    existingImport.value_set_id
  );
  const diff = computeImportDiff(existingManaged, existingImport.payload.codes);

  if (!diff.ok) {
    await tx`
      UPDATE awcms_mini_reference_imports
      SET status = 'rejected',
          rejection_reason = ${`Blocked at commit time — destructive replacement of referenced code(s): ${diff.blockedReplacements.join(", ")}`}
      WHERE id = ${importId}
    `;

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: MODULE_KEY,
      action: "commit",
      resourceType: "reference_import",
      resourceId: importId,
      severity: "critical",
      message: `Reference import commit REJECTED at commit time — destructive replacement of referenced code(s): ${diff.blockedReplacements.join(", ")}.`,
      attributes: { blockedReplacements: diff.blockedReplacements },
      correlationId
    });

    return {
      ok: false,
      reason: "blocked_by_referenced_codes",
      blockedCodes: diff.blockedReplacements
    };
  }

  const existingByCode = new Map(existingManaged.map((row) => [row.code, row]));
  const createdCodeIds: string[] = [];
  const updatedSnapshots: {
    codeId: string;
    code: string;
    before: {
      sortOrder: number;
      metadata: Record<string, unknown>;
      validFrom: Date;
      validTo: Date | null;
      deprecatedAt: Date | null;
    };
  }[] = [];
  const deprecatedCodeIds: string[] = [];

  for (const entry of diff.toCreate) {
    const inserted = (await tx`
      INSERT INTO awcms_mini_reference_codes
        (value_set_id, code, sort_order, metadata, valid_from, valid_to, provenance,
         managed_by_descriptor, import_batch_id, checksum, created_by, updated_by)
      VALUES (
        ${existingImport.value_set_id}, ${entry.code}, ${entry.sortOrder}, ${entry.metadata},
        ${entry.validFrom}, ${entry.validTo}, 'import', false, ${importId},
        ${computeRequestHash(entry)}, ${actorTenantUserId}, ${actorTenantUserId}
      )
      RETURNING id
    `) as { id: string }[];
    const codeId = inserted[0]!.id;
    createdCodeIds.push(codeId);
    for (const label of entry.labels) {
      await tx`
        INSERT INTO awcms_mini_reference_code_translations (code_id, locale, label, description)
        VALUES (${codeId}, ${label.locale}, ${label.label}, ${label.description})
      `;
    }
  }

  for (const entry of diff.toUpdate) {
    const before = existingByCode.get(entry.code)!;
    const beforeRows = (await tx`
      SELECT sort_order, metadata, valid_from, valid_to, deprecated_at
      FROM awcms_mini_reference_codes WHERE id = ${before.id}
    `) as {
      sort_order: number;
      metadata: Record<string, unknown>;
      valid_from: Date;
      valid_to: Date | null;
      deprecated_at: Date | null;
    }[];
    updatedSnapshots.push({
      codeId: before.id,
      code: entry.code,
      before: {
        sortOrder: Number(beforeRows[0]!.sort_order),
        metadata: beforeRows[0]!.metadata,
        validFrom: beforeRows[0]!.valid_from,
        validTo: beforeRows[0]!.valid_to,
        deprecatedAt: beforeRows[0]!.deprecated_at
      }
    });

    await tx`
      UPDATE awcms_mini_reference_codes
      SET sort_order = ${entry.sortOrder}, metadata = ${entry.metadata},
          valid_from = ${entry.validFrom}, valid_to = ${entry.validTo},
          deprecated_at = NULL, deprecated_by = NULL, deprecate_reason = NULL,
          superseded_by_code_id = NULL, checksum = ${computeRequestHash(entry)},
          updated_at = now(), updated_by = ${actorTenantUserId}
      WHERE id = ${before.id}
    `;
    await tx`DELETE FROM awcms_mini_reference_code_translations WHERE code_id = ${before.id}`;
    for (const label of entry.labels) {
      await tx`
        INSERT INTO awcms_mini_reference_code_translations (code_id, locale, label, description)
        VALUES (${before.id}, ${label.locale}, ${label.label}, ${label.description})
      `;
    }
  }

  for (const code of diff.toDeprecate) {
    const existingRow = existingByCode.get(code)!;
    const result = (await tx`
      UPDATE awcms_mini_reference_codes
      SET deprecated_at = now(), deprecate_reason = 'Removed from import source payload',
          updated_at = now(), updated_by = ${actorTenantUserId}
      WHERE id = ${existingRow.id} AND deprecated_at IS NULL
      RETURNING id
    `) as { id: string }[];
    if (result[0]) {
      deprecatedCodeIds.push(existingRow.id);
    }
  }

  const committedSnapshot = {
    createdCodeIds,
    updatedSnapshots,
    deprecatedCodeIds
  };

  const updatedImportRows = (await tx`
    UPDATE awcms_mini_reference_imports
    SET status = 'committed', committed_at = now(), committed_by = ${actorTenantUserId},
        diff_summary = ${{ ...existingImport.diff_summary, committedSnapshot }}
    WHERE id = ${importId}
    RETURNING id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
  `) as ImportDbRow[];

  const importRow = toRow(updatedImportRows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_IMPORT_COMMITTED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_import",
    aggregateId: importRow.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      valueSetId: existingImport.value_set_id,
      created: createdCodeIds.length,
      updated: updatedSnapshots.length,
      deprecated: deprecatedCodeIds.length
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "commit",
    resourceType: "reference_import",
    resourceId: importRow.id,
    severity: "critical",
    message: `Reference import committed (affects the GLOBAL baseline shared by every tenant) — created=${createdCodeIds.length}, updated=${updatedSnapshots.length}, deprecated=${deprecatedCodeIds.length}.`,
    attributes: {
      valueSetId: existingImport.value_set_id,
      created: createdCodeIds.length,
      updated: updatedSnapshots.length,
      deprecated: deprecatedCodeIds.length
    },
    correlationId
  });

  return { ok: true, import: importRow };
}

export type RollbackImportResult =
  | { ok: true; import: ReferenceImportRow }
  | { ok: false; reason: "not_found" }
  | {
      ok: false;
      reason: "invalid_status";
      status: ReferenceImportRow["status"];
    }
  | { ok: false; reason: "referenced_since_import"; blockedCodeIds: string[] };

export async function rollbackReferenceImport(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  importId: string,
  correlationId?: string
): Promise<RollbackImportResult> {
  const rows = (await tx`
    SELECT id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
    FROM awcms_mini_reference_imports
    WHERE id = ${importId}
    FOR UPDATE
  `) as ImportDbRow[];

  const existingImport = rows[0];
  if (!existingImport) {
    return { ok: false, reason: "not_found" };
  }
  if (existingImport.status !== "committed") {
    return {
      ok: false,
      reason: "invalid_status",
      status: existingImport.status
    };
  }

  const snapshot = (existingImport.diff_summary.committedSnapshot ?? {
    createdCodeIds: [],
    updatedSnapshots: [],
    deprecatedCodeIds: []
  }) as {
    createdCodeIds: string[];
    updatedSnapshots: {
      codeId: string;
      code: string;
      before: {
        sortOrder: number;
        metadata: Record<string, unknown>;
        validFrom: string;
        validTo: string | null;
        deprecatedAt: string | null;
      };
    }[];
    deprecatedCodeIds: string[];
  };

  // Never delete a created code that has since been referenced by a
  // tenant override/extension — same invariant the commit path enforces
  // (issue #750: never delete/repurpose a referenced code in place).
  const referencedRows = (await tx`
    SELECT base_code_id FROM awcms_mini_reference_tenant_codes
    WHERE base_code_id = ANY(${tx.array(snapshot.createdCodeIds.length > 0 ? snapshot.createdCodeIds : ["00000000-0000-0000-0000-000000000000"], "uuid")})
  `) as { base_code_id: string }[];
  const blockedCodeIds = [
    ...new Set(referencedRows.map((row) => row.base_code_id))
  ];
  if (blockedCodeIds.length > 0) {
    return { ok: false, reason: "referenced_since_import", blockedCodeIds };
  }

  for (const codeId of snapshot.createdCodeIds) {
    await tx`DELETE FROM awcms_mini_reference_codes WHERE id = ${codeId}`;
  }

  for (const entry of snapshot.updatedSnapshots) {
    await tx`
      UPDATE awcms_mini_reference_codes
      SET sort_order = ${entry.before.sortOrder}, metadata = ${entry.before.metadata},
          valid_from = ${entry.before.validFrom}, valid_to = ${entry.before.validTo},
          deprecated_at = ${entry.before.deprecatedAt}, updated_at = now(),
          updated_by = ${actorTenantUserId}
      WHERE id = ${entry.codeId}
    `;
  }

  for (const codeId of snapshot.deprecatedCodeIds) {
    await tx`
      UPDATE awcms_mini_reference_codes
      SET deprecated_at = NULL, deprecated_by = NULL, deprecate_reason = NULL,
          updated_at = now(), updated_by = ${actorTenantUserId}
      WHERE id = ${codeId} AND deprecated_at IS NOT NULL
    `;
  }

  const updatedImportRows = (await tx`
    UPDATE awcms_mini_reference_imports
    SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = ${actorTenantUserId}
    WHERE id = ${importId}
    RETURNING id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
  `) as ImportDbRow[];

  const importRow = toRow(updatedImportRows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_IMPORT_ROLLED_BACK_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_import",
    aggregateId: importRow.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { valueSetId: existingImport.value_set_id }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "rollback",
    resourceType: "reference_import",
    resourceId: importRow.id,
    severity: "critical",
    message:
      "Reference import rolled back (affects the GLOBAL baseline shared by every tenant).",
    attributes: { valueSetId: existingImport.value_set_id },
    correlationId
  });

  return { ok: true, import: importRow };
}

export async function fetchReferenceImportById(
  tx: Bun.SQL,
  importId: string
): Promise<ReferenceImportRow | null> {
  const rows = (await tx`
    SELECT id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
    FROM awcms_mini_reference_imports WHERE id = ${importId}
  `) as ImportDbRow[];
  return rows[0] ? toRow(rows[0]) : null;
}

/** Bounded list (`LIMIT 100`), newest first. */
export async function listReferenceImports(
  tx: Bun.SQL,
  valueSetId: string
): Promise<ReferenceImportRow[]> {
  const rows = (await tx`
    SELECT id, value_set_id, status, source_provenance, payload, checksum, diff_summary,
      rejection_reason, created_at
    FROM awcms_mini_reference_imports
    WHERE value_set_id = ${valueSetId}
    ORDER BY created_at DESC
    LIMIT 100
  `) as ImportDbRow[];
  return rows.map(toRow);
}
