/**
 * Reference code (global baseline) persistence + audit (Issue #750, epic
 * #738 platform-evolution Wave 3, ADR-0021). Same conventions
 * `value-set-directory.ts` documents (column lists spelled out per-query,
 * discriminated-union not-found results, GLOBAL table written inside a
 * `withTenant`-scoped transaction for the ACTOR's permission context
 * only).
 *
 * `managed_by_descriptor = true` rows are written ONLY by
 * `contribution-sync.ts` — every function here refuses to create/update/
 * deprecate a `managed_by_descriptor = true` row (issue #750: a module's
 * declared codes and an operator's manually added codes must never
 * collide) and instead returns `{ ok: false, reason: "descriptor_managed" }`.
 *
 * Deprecation is the "delete" for this resource — a code already
 * referenced by a tenant override/extension is NOT blocked from being
 * deprecated (deprecation is the SAFE way to retire a referenced code,
 * issue #750: "deprecate/supersede instead" of deleting) — only physical
 * deletion (which this file never performs) would need that guard, and
 * the import pipeline's `domain/import-diff.ts` is the ONLY place that
 * enforces the destructive-replace block.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  REFERENCE_DATA_CODE_CREATED_EVENT_TYPE,
  REFERENCE_DATA_CODE_DEPRECATED_EVENT_TYPE,
  REFERENCE_DATA_CODE_UPDATED_EVENT_TYPE,
  REFERENCE_DATA_EVENT_VERSION
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  validateCreateReferenceCodeInput,
  validateDeprecateReferenceCodeInput,
  validateUpdateReferenceCodeInput,
  type CreateReferenceCodeInput,
  type DeprecateReferenceCodeInput,
  type ReferenceCodeLabelInput,
  type ReferenceCodeValidationError,
  type UpdateReferenceCodeInput
} from "../domain/code";

const MODULE_KEY = "reference_data";

export type ReferenceCodeRow = {
  id: string;
  valueSetId: string;
  code: string;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecatedAt: Date | null;
  supersededByCodeId: string | null;
  provenance: string;
  managedByDescriptor: boolean;
  importBatchId: string | null;
  createdAt: Date;
  updatedAt: Date;
  labels: ReferenceCodeLabelInput[];
};

type CodeDbRow = {
  id: string;
  value_set_id: string;
  code: string;
  sort_order: number;
  metadata: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  deprecated_at: Date | null;
  superseded_by_code_id: string | null;
  provenance: string;
  managed_by_descriptor: boolean;
  import_batch_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type LabelDbRow = {
  code_id: string;
  locale: string;
  label: string;
  description: string | null;
};

async function fetchLabelsByCodeIds(
  tx: Bun.SQL,
  codeIds: string[]
): Promise<Map<string, ReferenceCodeLabelInput[]>> {
  if (codeIds.length === 0) {
    return new Map();
  }
  const rows = (await tx`
    SELECT code_id, locale, label, description FROM awcms_mini_reference_code_translations
    WHERE code_id = ANY(${tx.array(codeIds, "uuid")})
  `) as LabelDbRow[];

  const byCode = new Map<string, ReferenceCodeLabelInput[]>();
  for (const row of rows) {
    const list = byCode.get(row.code_id) ?? [];
    list.push({
      locale: row.locale,
      label: row.label,
      description: row.description
    });
    byCode.set(row.code_id, list);
  }
  return byCode;
}

function toRow(
  row: CodeDbRow,
  labels: ReferenceCodeLabelInput[]
): ReferenceCodeRow {
  return {
    id: row.id,
    valueSetId: row.value_set_id,
    code: row.code,
    sortOrder: Number(row.sort_order),
    metadata: row.metadata,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    deprecatedAt: row.deprecated_at,
    supersededByCodeId: row.superseded_by_code_id,
    provenance: row.provenance,
    managedByDescriptor: row.managed_by_descriptor,
    importBatchId: row.import_batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    labels
  };
}

async function replaceLabels(
  tx: Bun.SQL,
  codeId: string,
  labels: ReferenceCodeLabelInput[]
): Promise<void> {
  await tx`DELETE FROM awcms_mini_reference_code_translations WHERE code_id = ${codeId}`;
  for (const label of labels) {
    await tx`
      INSERT INTO awcms_mini_reference_code_translations (code_id, locale, label, description)
      VALUES (${codeId}, ${label.locale}, ${label.label}, ${label.description})
    `;
  }
}

export type CreateReferenceCodeResult =
  | { ok: true; code: ReferenceCodeRow }
  | { ok: false; reason: "validation"; errors: ReferenceCodeValidationError[] }
  | { ok: false; reason: "value_set_not_found" }
  | { ok: false; reason: "duplicate_code" };

export async function createReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  valueSetId: string,
  input: CreateReferenceCodeInput,
  correlationId?: string
): Promise<CreateReferenceCodeResult> {
  const errors = validateCreateReferenceCodeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const duplicate = (await tx`
    SELECT id FROM awcms_mini_reference_codes
    WHERE value_set_id = ${valueSetId} AND code = ${input.code}
  `) as { id: string }[];
  if (duplicate.length > 0) {
    return { ok: false, reason: "duplicate_code" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_reference_codes
      (value_set_id, code, sort_order, metadata, valid_from, valid_to, provenance,
       managed_by_descriptor, created_by, updated_by)
    VALUES (
      ${valueSetId}, ${input.code}, ${input.sortOrder}, ${input.metadata},
      ${input.validFrom}, ${input.validTo}, 'manual', false, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
  `) as CodeDbRow[];

  const inserted = rows[0]!;
  await replaceLabels(tx, inserted.id, input.labels);
  const code = toRow(inserted, input.labels);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_CODE_CREATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_code",
    aggregateId: code.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { valueSetId, code: code.code }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "reference_code",
    resourceId: code.id,
    severity: "info",
    message: `Reference code "${code.code}" created (affects the GLOBAL baseline shared by every tenant).`,
    attributes: { valueSetId, code: code.code },
    correlationId
  });

  return { ok: true, code };
}

export type UpdateReferenceCodeResult =
  | { ok: true; code: ReferenceCodeRow }
  | { ok: false; reason: "validation"; errors: ReferenceCodeValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "descriptor_managed" };

export async function updateReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  codeId: string,
  input: UpdateReferenceCodeInput,
  correlationId?: string
): Promise<UpdateReferenceCodeResult> {
  const errors = validateUpdateReferenceCodeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, managed_by_descriptor FROM awcms_mini_reference_codes WHERE id = ${codeId}
  `) as { id: string; managed_by_descriptor: boolean }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.managed_by_descriptor) {
    return { ok: false, reason: "descriptor_managed" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_codes
    SET sort_order = ${input.sortOrder}, metadata = ${input.metadata},
        valid_from = ${input.validFrom}, valid_to = ${input.validTo},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE id = ${codeId}
    RETURNING id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
  `) as CodeDbRow[];

  const updated = rows[0]!;
  await replaceLabels(tx, updated.id, input.labels);
  const code = toRow(updated, input.labels);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_CODE_UPDATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_code",
    aggregateId: code.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { code: code.code }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "reference_code",
    resourceId: code.id,
    severity: "info",
    message: `Reference code "${code.code}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, code };
}

export type DeprecateReferenceCodeResult =
  | { ok: true; code: ReferenceCodeRow }
  | { ok: false; reason: "validation"; errors: ReferenceCodeValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deprecated" }
  | { ok: false; reason: "descriptor_managed" };

export async function deprecateReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  codeId: string,
  input: DeprecateReferenceCodeInput,
  correlationId?: string
): Promise<DeprecateReferenceCodeResult> {
  const errors = validateDeprecateReferenceCodeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, deprecated_at, managed_by_descriptor FROM awcms_mini_reference_codes WHERE id = ${codeId}
  `) as {
    id: string;
    deprecated_at: Date | null;
    managed_by_descriptor: boolean;
  }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.managed_by_descriptor) {
    return { ok: false, reason: "descriptor_managed" };
  }
  if (existing.deprecated_at !== null) {
    return { ok: false, reason: "already_deprecated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_codes
    SET deprecated_at = now(), deprecated_by = ${actorTenantUserId},
        deprecate_reason = ${input.reason}, superseded_by_code_id = ${input.supersededByCodeId},
        updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE id = ${codeId} AND deprecated_at IS NULL
    RETURNING id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
  `) as CodeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deprecated" };
  }

  const labelsByCode = await fetchLabelsByCodeIds(tx, [rows[0].id]);
  const code = toRow(rows[0], labelsByCode.get(rows[0].id) ?? []);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_CODE_DEPRECATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_code",
    aggregateId: code.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { code: code.code, reason: input.reason }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "reference_code",
    resourceId: code.id,
    severity: "warning",
    message: `Reference code "${code.code}" deprecated (affects the GLOBAL baseline shared by every tenant).`,
    attributes: { reason: input.reason },
    correlationId
  });

  return { ok: true, code };
}

export type RestoreReferenceCodeResult =
  | { ok: true; code: ReferenceCodeRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deprecated" }
  | { ok: false; reason: "descriptor_managed" };

export async function restoreReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  codeId: string,
  correlationId?: string
): Promise<RestoreReferenceCodeResult> {
  const existingRows = (await tx`
    SELECT id, deprecated_at, managed_by_descriptor FROM awcms_mini_reference_codes WHERE id = ${codeId}
  `) as {
    id: string;
    deprecated_at: Date | null;
    managed_by_descriptor: boolean;
  }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  // Consistency with create/update/deprecate above — currently
  // unreachable in practice (no write path deprecates a
  // `managed_by_descriptor = true` code today, see `import-service.ts`'s
  // `fetchExistingManagedCodes` `provenance = 'import'` filter), but
  // guarded here too so this invariant can never be silently violated by
  // a future write path.
  if (existing.managed_by_descriptor) {
    return { ok: false, reason: "descriptor_managed" };
  }
  if (existing.deprecated_at === null) {
    return { ok: false, reason: "not_deprecated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_codes
    SET deprecated_at = NULL, deprecated_by = NULL, deprecate_reason = NULL,
        superseded_by_code_id = NULL, restored_at = now(), restored_by = ${actorTenantUserId},
        updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE id = ${codeId} AND deprecated_at IS NOT NULL
    RETURNING id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
  `) as CodeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deprecated" };
  }

  const labelsByCode = await fetchLabelsByCodeIds(tx, [rows[0].id]);
  const code = toRow(rows[0], labelsByCode.get(rows[0].id) ?? []);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "reference_code",
    resourceId: code.id,
    severity: "warning",
    message: `Reference code "${code.code}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, code };
}

export async function fetchReferenceCodeById(
  tx: Bun.SQL,
  codeId: string
): Promise<ReferenceCodeRow | null> {
  const rows = (await tx`
    SELECT id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
    FROM awcms_mini_reference_codes WHERE id = ${codeId}
  `) as CodeDbRow[];
  if (!rows[0]) {
    return null;
  }
  const labelsByCode = await fetchLabelsByCodeIds(tx, [rows[0].id]);
  return toRow(rows[0], labelsByCode.get(rows[0].id) ?? []);
}

export async function fetchReferenceCodeByCode(
  tx: Bun.SQL,
  valueSetId: string,
  code: string
): Promise<ReferenceCodeRow | null> {
  const rows = (await tx`
    SELECT id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
    FROM awcms_mini_reference_codes WHERE value_set_id = ${valueSetId} AND code = ${code}
  `) as CodeDbRow[];
  if (!rows[0]) {
    return null;
  }
  const labelsByCode = await fetchLabelsByCodeIds(tx, [rows[0].id]);
  return toRow(rows[0], labelsByCode.get(rows[0].id) ?? []);
}

export type ListReferenceCodesFilter = {
  includeDeprecated?: boolean;
  search?: string;
};

/** Bounded list (`LIMIT 500`), sorted by `sort_order` then `code`. */
export async function listReferenceCodes(
  tx: Bun.SQL,
  valueSetId: string,
  filter: ListReferenceCodesFilter = {}
): Promise<ReferenceCodeRow[]> {
  const rows = (await tx`
    SELECT id, value_set_id, code, sort_order, metadata, valid_from, valid_to,
      deprecated_at, superseded_by_code_id, provenance, managed_by_descriptor, import_batch_id,
      created_at, updated_at
    FROM awcms_mini_reference_codes
    WHERE value_set_id = ${valueSetId}
      AND (${filter.includeDeprecated ?? false} OR deprecated_at IS NULL)
      AND (${filter.search ?? null}::text IS NULL OR code ILIKE '%' || ${filter.search ?? null} || '%')
    ORDER BY sort_order ASC, code ASC
    LIMIT 500
  `) as CodeDbRow[];

  const labelsByCode = await fetchLabelsByCodeIds(
    tx,
    rows.map((row) => row.id)
  );
  return rows.map((row) => toRow(row, labelsByCode.get(row.id) ?? []));
}
