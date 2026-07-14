/**
 * Numbering sequence DEFINITION lifecycle (Issue #751) — define/revise/
 * deactivate/restore. Effective-dated SCD Type 2 style, same pattern
 * `organization-unit-hierarchy-service.ts`'s `reparentUnit` established
 * for this codebase: revising NEVER updates `format_template`/
 * `reset_policy` on an existing row — it closes the current open
 * definition (`effective_to = now()`) and opens a new one, carrying
 * `current_value`/`current_period_key` FORWARD so the counter is never
 * reset or reused just because the format changed. The partial unique
 * index in `sql/066` (`... WHERE effective_to IS NULL`) guarantees at
 * most one open definition per `(scope_type, scope_id, sequence_key)` at
 * the database level.
 *
 * Row-level `SELECT ... FOR UPDATE` on the CURRENT open definition row is
 * what makes this safe under concurrency with `document-number-
 * reservation-service.ts`'s `reserveNumber` (which locks the SAME row) —
 * a revision and a concurrent reservation against the same sequence can
 * never interleave: whichever transaction acquires the row lock first
 * runs to completion (commit or rollback) before the other proceeds.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordDocumentEvidence } from "./document-evidence-directory";
import {
  validateDefineSequenceInput,
  validateReviseSequenceInput,
  type DefineSequenceInput,
  type ReviseSequenceInput
} from "../domain/document-number-sequence";
import type { DocumentValidationError } from "../domain/errors";

const MODULE_KEY = "document_infrastructure";

export type NumberSequenceRow = {
  id: string;
  tenantId: string;
  scopeType: string;
  scopeId: string | null;
  sequenceKey: string;
  formatTemplate: string;
  resetPolicy: string;
  currentPeriodKey: string | null;
  currentValue: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  revisionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type NumberSequenceDbRow = {
  id: string;
  tenant_id: string;
  scope_type: string;
  scope_id: string | null;
  sequence_key: string;
  format_template: string;
  reset_policy: string;
  current_period_key: string | null;
  current_value: number | string;
  effective_from: Date;
  effective_to: Date | null;
  revision_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function toRow(row: NumberSequenceDbRow): NumberSequenceRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    sequenceKey: row.sequence_key,
    formatTemplate: row.format_template,
    resetPolicy: row.reset_policy,
    currentPeriodKey: row.current_period_key,
    currentValue: Number(row.current_value),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    revisionReason: row.revision_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type SequenceScope = {
  scopeType: string;
  scopeId: string | null;
  sequenceKey: string;
};

/** The row currently OPEN (`effective_to IS NULL`) for a scope, if any — the definition new reservations/revisions act against. `FOR UPDATE` only when `lock` is true (defaults false — read-only callers like `fetchCurrentSequence` should never hold a lock). */
async function fetchOpenSequenceRow(
  tx: Bun.SQL,
  tenantId: string,
  scope: SequenceScope,
  lock: boolean
): Promise<NumberSequenceDbRow | null> {
  const rows = lock
    ? ((await tx`
        SELECT id, tenant_id, scope_type, scope_id, sequence_key, format_template,
          reset_policy, current_period_key, current_value, effective_from,
          effective_to, revision_reason, created_at, updated_at
        FROM awcms_mini_document_number_sequences
        WHERE tenant_id = ${tenantId} AND scope_type = ${scope.scopeType}
          AND scope_id IS NOT DISTINCT FROM ${scope.scopeId}
          AND sequence_key = ${scope.sequenceKey} AND effective_to IS NULL
        FOR UPDATE
      `) as NumberSequenceDbRow[])
    : ((await tx`
        SELECT id, tenant_id, scope_type, scope_id, sequence_key, format_template,
          reset_policy, current_period_key, current_value, effective_from,
          effective_to, revision_reason, created_at, updated_at
        FROM awcms_mini_document_number_sequences
        WHERE tenant_id = ${tenantId} AND scope_type = ${scope.scopeType}
          AND scope_id IS NOT DISTINCT FROM ${scope.scopeId}
          AND sequence_key = ${scope.sequenceKey} AND effective_to IS NULL
      `) as NumberSequenceDbRow[]);

  return rows[0] ?? null;
}

export type DefineSequenceResult =
  | { ok: true; sequence: NumberSequenceRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "already_defined" };

export async function defineSequence(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: DefineSequenceInput,
  correlationId?: string
): Promise<DefineSequenceResult> {
  const errors = validateDefineSequenceInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existing = await fetchOpenSequenceRow(
    tx,
    tenantId,
    {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      sequenceKey: input.sequenceKey
    },
    false
  );
  if (existing) {
    return { ok: false, reason: "already_defined" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_document_number_sequences
      (tenant_id, scope_type, scope_id, sequence_key, format_template,
       reset_policy, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.scopeType}, ${input.scopeId}, ${input.sequenceKey},
      ${input.formatTemplate}, ${input.resetPolicy}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
  `) as NumberSequenceDbRow[];

  const sequence = toRow(rows[0]!);

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "sequence_defined",
    subjectType: "number_sequence",
    subjectId: sequence.id,
    sequenceId: sequence.id,
    actorTenantUserId,
    metadata: {
      scopeType: sequence.scopeType,
      scopeId: sequence.scopeId,
      sequenceKey: sequence.sequenceKey
    },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "document_number_sequence",
    resourceId: sequence.id,
    severity: "info",
    message: `Number sequence "${sequence.sequenceKey}" defined for scope ${sequence.scopeType}${sequence.scopeId ? `:${sequence.scopeId}` : ""}.`,
    attributes: {
      scopeType: sequence.scopeType,
      sequenceKey: sequence.sequenceKey
    },
    correlationId
  });

  return { ok: true, sequence };
}

export type ReviseSequenceResult =
  | { ok: true; sequence: NumberSequenceRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" };

export async function reviseSequenceDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  scope: SequenceScope,
  input: ReviseSequenceInput,
  correlationId?: string
): Promise<ReviseSequenceResult> {
  const errors = validateReviseSequenceInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const current = await fetchOpenSequenceRow(tx, tenantId, scope, true);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  const now = new Date();

  await tx`
    UPDATE awcms_mini_document_number_sequences
    SET effective_to = ${now}
    WHERE id = ${current.id} AND tenant_id = ${tenantId} AND effective_to IS NULL
  `;

  const rows = (await tx`
    INSERT INTO awcms_mini_document_number_sequences
      (tenant_id, scope_type, scope_id, sequence_key, format_template,
       reset_policy, current_period_key, current_value, effective_from,
       revision_reason, created_by, updated_by)
    VALUES (
      ${tenantId}, ${current.scope_type}, ${current.scope_id}, ${current.sequence_key},
      ${input.formatTemplate}, ${input.resetPolicy}, ${current.current_period_key},
      ${current.current_value}, ${now}, ${input.revisionReason}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
  `) as NumberSequenceDbRow[];

  const sequence = toRow(rows[0]!);

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "sequence_revised",
    subjectType: "number_sequence",
    subjectId: sequence.id,
    sequenceId: sequence.id,
    actorTenantUserId,
    reason: input.revisionReason,
    metadata: {
      previousSequenceId: current.id,
      currentValueCarriedForward: sequence.currentValue
    },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "document_number_sequence",
    resourceId: sequence.id,
    severity: "warning",
    message: `Number sequence "${sequence.sequenceKey}" definition revised.`,
    attributes: { revisionReason: input.revisionReason },
    correlationId
  });

  return { ok: true, sequence };
}

export type DeactivateSequenceResult =
  | { ok: true; sequence: NumberSequenceRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" };

export async function deactivateSequenceDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  scope: SequenceScope,
  deleteReason: string,
  correlationId?: string
): Promise<DeactivateSequenceResult> {
  if (!deleteReason || deleteReason.trim().length === 0) {
    return {
      ok: false,
      reason: "validation",
      errors: [{ field: "deleteReason", message: "deleteReason is required." }]
    };
  }

  const current = await fetchOpenSequenceRow(tx, tenantId, scope, true);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  const closedRows = (await tx`
    UPDATE awcms_mini_document_number_sequences
    SET effective_to = now(), revision_reason = ${deleteReason}, updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE id = ${current.id} AND tenant_id = ${tenantId} AND effective_to IS NULL
    RETURNING id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
  `) as NumberSequenceDbRow[];

  const sequence = toRow(closedRows[0]!);

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "sequence_deactivated",
    subjectType: "number_sequence",
    subjectId: current.id,
    sequenceId: current.id,
    actorTenantUserId,
    reason: deleteReason,
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "document_number_sequence",
    resourceId: current.id,
    severity: "warning",
    message: `Number sequence "${current.sequence_key}" deactivated.`,
    attributes: { deleteReason },
    correlationId
  });

  return { ok: true, sequence };
}

export type RestoreSequenceResult =
  | { ok: true; sequence: NumberSequenceRow }
  | { ok: false; reason: "already_active" }
  | { ok: false; reason: "not_found" };

/** Reactivates the most recently closed definition for a scope by opening a NEW row carrying its format/reset-policy/counter forward — never re-opens the old row in place, same "no in-place mutation" convention every other write path in this file follows. */
export async function restoreSequenceDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  scope: SequenceScope,
  correlationId?: string
): Promise<RestoreSequenceResult> {
  const currentlyOpen = await fetchOpenSequenceRow(tx, tenantId, scope, false);
  if (currentlyOpen) {
    return { ok: false, reason: "already_active" };
  }

  const lastClosedRows = (await tx`
    SELECT id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
    FROM awcms_mini_document_number_sequences
    WHERE tenant_id = ${tenantId} AND scope_type = ${scope.scopeType}
      AND scope_id IS NOT DISTINCT FROM ${scope.scopeId}
      AND sequence_key = ${scope.sequenceKey}
    ORDER BY effective_to DESC NULLS LAST
    LIMIT 1
    FOR UPDATE
  `) as NumberSequenceDbRow[];

  const lastClosed = lastClosedRows[0];
  if (!lastClosed) {
    return { ok: false, reason: "not_found" };
  }

  const now = new Date();
  const rows = (await tx`
    INSERT INTO awcms_mini_document_number_sequences
      (tenant_id, scope_type, scope_id, sequence_key, format_template,
       reset_policy, current_period_key, current_value, effective_from,
       revision_reason, created_by, updated_by)
    VALUES (
      ${tenantId}, ${lastClosed.scope_type}, ${lastClosed.scope_id}, ${lastClosed.sequence_key},
      ${lastClosed.format_template}, ${lastClosed.reset_policy}, ${lastClosed.current_period_key},
      ${lastClosed.current_value}, ${now}, 'restored', ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
  `) as NumberSequenceDbRow[];

  const sequence = toRow(rows[0]!);

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "sequence_restored",
    subjectType: "number_sequence",
    subjectId: sequence.id,
    sequenceId: sequence.id,
    actorTenantUserId,
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "document_number_sequence",
    resourceId: sequence.id,
    severity: "warning",
    message: `Number sequence "${sequence.sequenceKey}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, sequence };
}

export async function fetchCurrentSequence(
  tx: Bun.SQL,
  tenantId: string,
  scope: SequenceScope
): Promise<NumberSequenceRow | null> {
  const row = await fetchOpenSequenceRow(tx, tenantId, scope, false);
  return row ? toRow(row) : null;
}

export async function fetchSequenceById(
  tx: Bun.SQL,
  tenantId: string,
  sequenceId: string
): Promise<NumberSequenceRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
    FROM awcms_mini_document_number_sequences
    WHERE tenant_id = ${tenantId} AND id = ${sequenceId}
  `) as NumberSequenceDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

/** Full effective-dated history (open + closed rows) for a scope, newest first — the "history" surface the admin UI shows. Bounded `LIMIT 200`. */
export async function listSequenceHistory(
  tx: Bun.SQL,
  tenantId: string,
  scope: SequenceScope
): Promise<NumberSequenceRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
    FROM awcms_mini_document_number_sequences
    WHERE tenant_id = ${tenantId} AND scope_type = ${scope.scopeType}
      AND scope_id IS NOT DISTINCT FROM ${scope.scopeId}
      AND sequence_key = ${scope.sequenceKey}
    ORDER BY effective_from DESC
    LIMIT 200
  `) as NumberSequenceDbRow[];

  return rows.map(toRow);
}

/** Every CURRENTLY OPEN sequence definition for the tenant — bounded `LIMIT 200`. */
export async function listCurrentSequences(
  tx: Bun.SQL,
  tenantId: string
): Promise<NumberSequenceRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, scope_type, scope_id, sequence_key, format_template,
      reset_policy, current_period_key, current_value, effective_from,
      effective_to, revision_reason, created_at, updated_at
    FROM awcms_mini_document_number_sequences
    WHERE tenant_id = ${tenantId} AND effective_to IS NULL
    ORDER BY created_at DESC
    LIMIT 200
  `) as NumberSequenceDbRow[];

  return rows.map(toRow);
}
