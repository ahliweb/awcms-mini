/**
 * Concurrency-safe number RESERVATION (Issue #751 — the operation named
 * explicitly in the issue title). `reserveNumber` is the ONLY function
 * that increments `awcms_mini_document_number_sequences.current_value` —
 * it does so by `SELECT ... FOR UPDATE` on the sequence's CURRENT open
 * definition row, so two concurrent callers targeting the SAME sequence
 * are serialized by Postgres's own row lock: whichever transaction
 * acquires the lock first reads/increments/commits before the second
 * transaction's `SELECT ... FOR UPDATE` is even allowed to return,
 * guaranteeing distinct `reserved_number` values under real concurrent
 * load (proven by
 * `tests/integration/document-infrastructure-numbering.integration.test.ts`'s
 * genuine parallel-request test — not just documented, exercised).
 *
 * `UNIQUE (tenant_id, sequence_id, reserved_number)` (sql/066) is the
 * database-level backstop: even if the row lock were somehow bypassed, a
 * duplicate `reserved_number` would fail with a unique-violation rather
 * than silently double-allocate — and since the counter only ever
 * increases (never decremented on cancel), that same constraint is what
 * makes "no silent number reuse" true regardless of a reservation's
 * final status (reserved/committed/canceled all permanently occupy their
 * slot).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
  DOCUMENT_INFRASTRUCTURE_NUMBER_CANCELED_EVENT_TYPE,
  DOCUMENT_INFRASTRUCTURE_NUMBER_COMMITTED_EVENT_TYPE,
  DOCUMENT_INFRASTRUCTURE_NUMBER_RESERVED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { recordDocumentEvidence } from "./document-evidence-directory";
import {
  computeNextSequenceValue,
  computePeriodKey,
  validateCancelReservationInput,
  type ResetPolicy
} from "../domain/document-number-sequence";
import { renderNumberFormatTemplate } from "../domain/number-format-template";
import type { DocumentValidationError } from "../domain/errors";
import type { SequenceScope } from "./document-number-sequence-definition-service";

const MODULE_KEY = "document_infrastructure";

export type NumberReservationRow = {
  id: string;
  tenantId: string;
  sequenceId: string;
  reservedNumber: number;
  formattedNumber: string;
  periodKey: string | null;
  status: "reserved" | "committed" | "canceled";
  documentId: string | null;
  reservedByTenantUserId: string | null;
  reservedAt: Date;
  committedAt: Date | null;
  committedByTenantUserId: string | null;
  canceledAt: Date | null;
  canceledByTenantUserId: string | null;
  cancelReason: string | null;
  correlationId: string | null;
};

type NumberReservationDbRow = {
  id: string;
  tenant_id: string;
  sequence_id: string;
  reserved_number: number | string;
  formatted_number: string;
  period_key: string | null;
  status: "reserved" | "committed" | "canceled";
  document_id: string | null;
  reserved_by_tenant_user_id: string | null;
  reserved_at: Date;
  committed_at: Date | null;
  committed_by_tenant_user_id: string | null;
  canceled_at: Date | null;
  canceled_by_tenant_user_id: string | null;
  cancel_reason: string | null;
  correlation_id: string | null;
};

function toRow(row: NumberReservationDbRow): NumberReservationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sequenceId: row.sequence_id,
    reservedNumber: Number(row.reserved_number),
    formattedNumber: row.formatted_number,
    periodKey: row.period_key,
    status: row.status,
    documentId: row.document_id,
    reservedByTenantUserId: row.reserved_by_tenant_user_id,
    reservedAt: row.reserved_at,
    committedAt: row.committed_at,
    committedByTenantUserId: row.committed_by_tenant_user_id,
    canceledAt: row.canceled_at,
    canceledByTenantUserId: row.canceled_by_tenant_user_id,
    cancelReason: row.cancel_reason,
    correlationId: row.correlation_id
  };
}

export type ReserveNumberResult =
  | { ok: true; reservation: NumberReservationRow }
  | { ok: false; reason: "sequence_not_found" };

export async function reserveNumber(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  scope: SequenceScope,
  correlationId?: string
): Promise<ReserveNumberResult> {
  // THE serialization point — see file header. Every concurrent caller
  // targeting this exact (scope_type, scope_id, sequence_key) blocks here
  // until the previous holder's transaction commits or rolls back.
  const sequenceRows = (await tx`
    SELECT id, format_template, reset_policy, current_period_key, current_value
    FROM awcms_mini_document_number_sequences
    WHERE tenant_id = ${tenantId} AND scope_type = ${scope.scopeType}
      AND scope_id IS NOT DISTINCT FROM ${scope.scopeId}
      AND sequence_key = ${scope.sequenceKey} AND effective_to IS NULL
    FOR UPDATE
  `) as {
    id: string;
    format_template: string;
    reset_policy: ResetPolicy;
    current_period_key: string | null;
    current_value: number | string;
  }[];

  const sequence = sequenceRows[0];
  if (!sequence) {
    return { ok: false, reason: "sequence_not_found" };
  }

  const now = new Date();
  const newPeriodKey = computePeriodKey(sequence.reset_policy, now);
  const nextValue = computeNextSequenceValue(
    Number(sequence.current_value),
    sequence.current_period_key,
    newPeriodKey
  );
  const formattedNumber = renderNumberFormatTemplate(sequence.format_template, {
    sequenceValue: nextValue,
    date: now
  });

  await tx`
    UPDATE awcms_mini_document_number_sequences
    SET current_value = ${nextValue}, current_period_key = ${newPeriodKey}, updated_at = now()
    WHERE id = ${sequence.id}
  `;

  const insertedRows = (await tx`
    INSERT INTO awcms_mini_document_number_reservations
      (tenant_id, sequence_id, reserved_number, formatted_number, period_key,
       reserved_by_tenant_user_id, correlation_id)
    VALUES (
      ${tenantId}, ${sequence.id}, ${nextValue}, ${formattedNumber}, ${newPeriodKey},
      ${actorTenantUserId}, ${correlationId ?? null}
    )
    RETURNING id, tenant_id, sequence_id, reserved_number, formatted_number,
      period_key, status, document_id, reserved_by_tenant_user_id, reserved_at,
      committed_at, committed_by_tenant_user_id, canceled_at,
      canceled_by_tenant_user_id, cancel_reason, correlation_id
  `) as NumberReservationDbRow[];

  const reservation = toRow(insertedRows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_NUMBER_RESERVED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "number_reservation",
    aggregateId: reservation.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId: actorTenantUserId ?? undefined,
    payload: {
      sequenceId: sequence.id,
      reservedNumber: reservation.reservedNumber,
      formattedNumber: reservation.formattedNumber
    }
  });

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "number_reserved",
    subjectType: "number_reservation",
    subjectId: reservation.id,
    sequenceId: sequence.id,
    reservationId: reservation.id,
    actorTenantUserId,
    metadata: {
      reservedNumber: reservation.reservedNumber,
      formattedNumber: reservation.formattedNumber
    },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "reserve",
    resourceType: "document_number_reservation",
    resourceId: reservation.id,
    severity: "info",
    message: `Number ${reservation.formattedNumber} reserved from sequence ${scope.sequenceKey}.`,
    attributes: { scopeType: scope.scopeType, sequenceKey: scope.sequenceKey },
    correlationId
  });

  return { ok: true, reservation };
}

export type CommitReservationResult =
  | { ok: true; reservation: NumberReservationRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_reserved" }
  | { ok: false; reason: "document_not_found" };

export async function commitReservation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  reservationId: string,
  documentId: string,
  correlationId?: string
): Promise<CommitReservationResult> {
  const existingRows = (await tx`
    SELECT id, status FROM awcms_mini_document_number_reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
    FOR UPDATE
  `) as { id: string; status: string }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "reserved") {
    return { ok: false, reason: "not_reserved" };
  }

  const documentRows = (await tx`
    SELECT id FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (!documentRows[0]) {
    return { ok: false, reason: "document_not_found" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_document_number_reservations
    SET status = 'committed', document_id = ${documentId}, committed_at = now(),
        committed_by_tenant_user_id = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${reservationId} AND status = 'reserved'
    RETURNING id, tenant_id, sequence_id, reserved_number, formatted_number,
      period_key, status, document_id, reserved_by_tenant_user_id, reserved_at,
      committed_at, committed_by_tenant_user_id, canceled_at,
      canceled_by_tenant_user_id, cancel_reason, correlation_id
  `) as NumberReservationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_reserved" };
  }

  const reservation = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_NUMBER_COMMITTED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "number_reservation",
    aggregateId: reservation.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { documentId, formattedNumber: reservation.formattedNumber }
  });

  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "number_committed",
    subjectType: "number_reservation",
    subjectId: reservation.id,
    sequenceId: reservation.sequenceId,
    reservationId: reservation.id,
    documentId,
    actorTenantUserId,
    metadata: { formattedNumber: reservation.formattedNumber },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "commit",
    resourceType: "document_number_reservation",
    resourceId: reservation.id,
    severity: "info",
    message: `Number ${reservation.formattedNumber} committed to document ${documentId}.`,
    attributes: { documentId },
    correlationId
  });

  return { ok: true, reservation };
}

export type CancelReservationResult =
  | { ok: true; reservation: NumberReservationRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_reserved" };

export async function cancelReservation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  reservationId: string,
  cancelReason: string,
  correlationId?: string
): Promise<CancelReservationResult> {
  const errors = validateCancelReservationInput({ cancelReason });
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, status FROM awcms_mini_document_number_reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
    FOR UPDATE
  `) as { id: string; status: string }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "reserved") {
    return { ok: false, reason: "not_reserved" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_document_number_reservations
    SET status = 'canceled', canceled_at = now(), canceled_by_tenant_user_id = ${actorTenantUserId},
        cancel_reason = ${cancelReason}
    WHERE tenant_id = ${tenantId} AND id = ${reservationId} AND status = 'reserved'
    RETURNING id, tenant_id, sequence_id, reserved_number, formatted_number,
      period_key, status, document_id, reserved_by_tenant_user_id, reserved_at,
      committed_at, committed_by_tenant_user_id, canceled_at,
      canceled_by_tenant_user_id, cancel_reason, correlation_id
  `) as NumberReservationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_reserved" };
  }

  const reservation = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: DOCUMENT_INFRASTRUCTURE_NUMBER_CANCELED_EVENT_TYPE,
    eventVersion: DOCUMENT_INFRASTRUCTURE_EVENT_VERSION,
    aggregateType: "number_reservation",
    aggregateId: reservation.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { formattedNumber: reservation.formattedNumber, cancelReason }
  });

  // Gap evidence — the reserved number is now permanently unused BUT
  // never reusable (see file header: the counter only ever increases and
  // `UNIQUE (sequence_id, reserved_number)` forbids re-issuing it).
  await recordDocumentEvidence(tx, tenantId, {
    evidenceType: "number_canceled",
    subjectType: "number_reservation",
    subjectId: reservation.id,
    sequenceId: reservation.sequenceId,
    reservationId: reservation.id,
    actorTenantUserId,
    reason: cancelReason,
    metadata: { formattedNumber: reservation.formattedNumber, gap: true },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "cancel",
    resourceType: "document_number_reservation",
    resourceId: reservation.id,
    severity: "warning",
    message: `Number ${reservation.formattedNumber} reservation canceled.`,
    attributes: { cancelReason },
    correlationId
  });

  return { ok: true, reservation };
}

export type ListReservationsFilter = {
  sequenceId?: string;
  status?: "reserved" | "committed" | "canceled";
};

/** Bounded list (`LIMIT 200`), newest first. */
export async function listReservations(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListReservationsFilter = {}
): Promise<NumberReservationRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, sequence_id, reserved_number, formatted_number,
      period_key, status, document_id, reserved_by_tenant_user_id, reserved_at,
      committed_at, committed_by_tenant_user_id, canceled_at,
      canceled_by_tenant_user_id, cancel_reason, correlation_id
    FROM awcms_mini_document_number_reservations
    WHERE tenant_id = ${tenantId}
      AND (${filter.sequenceId ?? null}::uuid IS NULL OR sequence_id = ${filter.sequenceId ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
    ORDER BY reserved_at DESC
    LIMIT 200
  `) as NumberReservationDbRow[];

  return rows.map(toRow);
}
