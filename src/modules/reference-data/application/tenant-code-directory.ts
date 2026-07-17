/**
 * Tenant reference-code override/extension persistence + audit (Issue
 * #750, epic #738 platform-evolution Wave 3, ADR-0021 §8). Same
 * conventions `value-set-directory.ts`/`code-directory.ts` document.
 *
 * `awcms_mini_reference_tenant_codes` is TENANT-SCOPED (RLS FORCE,
 * predicate always and only `tenant_id`) — `tx` MUST be `withTenant`-
 * scoped; every function here writes ONLY to this tenant-owned table,
 * NEVER to `awcms_mini_reference_value_sets`/`awcms_mini_reference_codes`
 * (issue #750 security requirement: "Tenant override cannot mutate
 * global/module baseline rows or affect another tenant").
 *
 * `override_policy` (the OWNING value set's server-side-read attribute,
 * never trusted from request input) gates which `kind` (`override` vs
 * `extension`, `domain/tenant-code.ts`) a tenant may create — enforced
 * here, the only call site.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  REFERENCE_DATA_EVENT_VERSION,
  REFERENCE_DATA_TENANT_CODE_CREATED_EVENT_TYPE,
  REFERENCE_DATA_TENANT_CODE_DEPRECATED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  isTenantCodeKindAllowed,
  validateCreateTenantReferenceCodeInput,
  validateDeprecateTenantReferenceCodeInput,
  validateUpdateTenantReferenceCodeInput,
  type CreateTenantReferenceCodeInput,
  type DeprecateTenantReferenceCodeInput
} from "../domain/tenant-code";
import type {
  ReferenceCodeLabelInput,
  ReferenceCodeValidationError
} from "../domain/code";
import {
  isEmptyReferenceCodePatch,
  mergeReferenceCodePatchInput,
  type ReferenceCodePatchInput
} from "../domain/code-patch";
import type { ReferenceValueSetOverridePolicy } from "../domain/value-set";

const MODULE_KEY = "reference_data";

export type TenantReferenceCodeRow = {
  id: string;
  tenantId: string;
  valueSetId: string;
  baseCodeId: string | null;
  code: string;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  labels: ReferenceCodeLabelInput[];
};

type TenantCodeDbRow = {
  id: string;
  tenant_id: string;
  value_set_id: string;
  base_code_id: string | null;
  code: string;
  sort_order: number;
  metadata: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  deprecated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type TenantLabelDbRow = {
  tenant_code_id: string;
  locale: string;
  label: string;
  description: string | null;
};

async function fetchLabelsByTenantCodeIds(
  tx: Bun.SQL,
  ids: string[]
): Promise<Map<string, ReferenceCodeLabelInput[]>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = (await tx`
    SELECT tenant_code_id, locale, label, description
    FROM awcms_mini_reference_tenant_code_translations
    WHERE tenant_code_id = ANY(${tx.array(ids, "uuid")})
  `) as TenantLabelDbRow[];

  const byId = new Map<string, ReferenceCodeLabelInput[]>();
  for (const row of rows) {
    const list = byId.get(row.tenant_code_id) ?? [];
    list.push({
      locale: row.locale,
      label: row.label,
      description: row.description
    });
    byId.set(row.tenant_code_id, list);
  }
  return byId;
}

function toRow(
  row: TenantCodeDbRow,
  labels: ReferenceCodeLabelInput[]
): TenantReferenceCodeRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    valueSetId: row.value_set_id,
    baseCodeId: row.base_code_id,
    code: row.code,
    sortOrder: Number(row.sort_order),
    metadata: row.metadata,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    deprecatedAt: row.deprecated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    labels
  };
}

async function replaceTenantLabels(
  tx: Bun.SQL,
  tenantId: string,
  tenantCodeId: string,
  labels: ReferenceCodeLabelInput[]
): Promise<void> {
  await tx`
    DELETE FROM awcms_mini_reference_tenant_code_translations
    WHERE tenant_id = ${tenantId} AND tenant_code_id = ${tenantCodeId}
  `;
  for (const label of labels) {
    await tx`
      INSERT INTO awcms_mini_reference_tenant_code_translations
        (tenant_id, tenant_code_id, locale, label, description)
      VALUES (${tenantId}, ${tenantCodeId}, ${label.locale}, ${label.label}, ${label.description})
    `;
  }
}

export type CreateTenantReferenceCodeResult =
  | { ok: true; tenantCode: TenantReferenceCodeRow }
  | { ok: false; reason: "validation"; errors: ReferenceCodeValidationError[] }
  | { ok: false; reason: "value_set_not_found" }
  | { ok: false; reason: "base_code_not_found" }
  | { ok: false; reason: "policy_forbids_kind"; kind: "override" | "extension" }
  | { ok: false; reason: "code_mismatch_with_base_code"; baseCode: string }
  | { ok: false; reason: "code_collides_with_baseline" }
  | { ok: false; reason: "duplicate_code" };

/**
 * Security-review Critical finding: `kind` alone (derived purely from
 * whether `baseCodeId` is null) is NOT sufficient to enforce
 * `overridePolicy` — the submitted `code` string must also be checked
 * against reality, in BOTH directions:
 *
 * 1. **Override direction**: a caller could set `baseCodeId` to a real
 *    code's id while submitting an unrelated `code` string. Under
 *    `tenant_override` (extension explicitly forbidden), this would let a
 *    tenant introduce a brand-new code disguised as an "override",
 *    bypassing the policy. Fixed by requiring `input.code` to equal the
 *    referenced base row's own `code` — an override always restates the
 *    SAME code, never a different one.
 * 2. **Extension direction (worse)**: submitting `baseCodeId: null` with a
 *    `code` that already exists in the GLOBAL baseline would pass
 *    validation as a legitimate "extension" even under `tenant_extend`
 *    (whose own contract is "add NEW codes, never override an existing
 *    one") — and because `domain/resolution.ts`'s merge always lets a
 *    same-`code` tenant row win over baseline, this "extension" would
 *    silently shadow/override the baseline in every resolved view for
 *    that tenant, exactly the effect the policy forbids. Fixed by
 *    rejecting an extension whose `code` collides with an existing
 *    baseline code in the same value set.
 */
export async function createTenantReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  valueSetId: string,
  overridePolicy: ReferenceValueSetOverridePolicy,
  input: CreateTenantReferenceCodeInput,
  correlationId?: string
): Promise<CreateTenantReferenceCodeResult> {
  const errors = validateCreateTenantReferenceCodeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const kind = input.baseCodeId === null ? "extension" : "override";
  if (!isTenantCodeKindAllowed(overridePolicy, kind)) {
    return { ok: false, reason: "policy_forbids_kind", kind };
  }

  if (input.baseCodeId !== null) {
    const baseRows = (await tx`
      SELECT id, code FROM awcms_mini_reference_codes
      WHERE id = ${input.baseCodeId} AND value_set_id = ${valueSetId}
    `) as { id: string; code: string }[];
    if (!baseRows[0]) {
      return { ok: false, reason: "base_code_not_found" };
    }
    // Direction 1: an override must restate the SAME code as the base row
    // it points to — never a different one (that would be an undeclared
    // extension disguised as an override).
    if (baseRows[0].code !== input.code) {
      return {
        ok: false,
        reason: "code_mismatch_with_base_code",
        baseCode: baseRows[0].code
      };
    }
  } else {
    // Direction 2: an extension's code must NOT already exist in the
    // global baseline — otherwise it would silently shadow/override the
    // baseline in the resolved view without ever going through the
    // `tenant_override` policy check above.
    const collidingBaseline = (await tx`
      SELECT id FROM awcms_mini_reference_codes
      WHERE value_set_id = ${valueSetId} AND code = ${input.code}
    `) as { id: string }[];
    if (collidingBaseline.length > 0) {
      return { ok: false, reason: "code_collides_with_baseline" };
    }
  }

  const duplicate = (await tx`
    SELECT id FROM awcms_mini_reference_tenant_codes
    WHERE tenant_id = ${tenantId} AND value_set_id = ${valueSetId} AND code = ${input.code}
  `) as { id: string }[];
  if (duplicate.length > 0) {
    return { ok: false, reason: "duplicate_code" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_reference_tenant_codes
      (tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from, valid_to,
       created_by, updated_by)
    VALUES (
      ${tenantId}, ${valueSetId}, ${input.baseCodeId}, ${input.code}, ${input.sortOrder},
      ${input.metadata}, ${input.validFrom}, ${input.validTo}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from,
      valid_to, deprecated_at, created_at, updated_at
  `) as TenantCodeDbRow[];

  const inserted = rows[0]!;
  await replaceTenantLabels(tx, tenantId, inserted.id, input.labels);
  const tenantCode = toRow(inserted, input.labels);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_TENANT_CODE_CREATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_tenant_code",
    aggregateId: tenantCode.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { valueSetId, code: tenantCode.code, kind }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "reference_tenant_code",
    resourceId: tenantCode.id,
    severity: "info",
    message: `Tenant reference code ${kind} "${tenantCode.code}" created.`,
    attributes: { valueSetId, code: tenantCode.code, kind },
    correlationId
  });

  return { ok: true, tenantCode };
}

export type UpdateTenantReferenceCodeResult =
  | { ok: true; tenantCode: TenantReferenceCodeRow; noop: boolean }
  | { ok: false; reason: "validation"; errors: ReferenceCodeValidationError[] }
  | { ok: false; reason: "not_found" };

/**
 * Apply a partial `PATCH` to a tenant reference code.
 *
 * Takes the caller's already-fetched `existing` row plus the raw
 * {@link ReferenceCodePatchInput} and owns EVERY decision that depends on the
 * patch shape — the deprecated-row refusal AND the documented empty-`{}` no-op
 * — so a caller can never re-derive one of them and drift (Issue #843). A
 * deprecated row is `not_found` here (mirroring the `AND deprecated_at IS NULL`
 * filter the real UPDATE carries), checked BEFORE the no-op short-circuit so an
 * empty patch on a deprecated code stays a `404`, never a live-looking `200`
 * (#839 round 3). A genuine no-op returns the row verbatim with `noop: true`
 * and performs NO write or audit event.
 */
export async function updateTenantReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  existing: TenantReferenceCodeRow,
  patch: ReferenceCodePatchInput,
  correlationId?: string
): Promise<UpdateTenantReferenceCodeResult> {
  if (existing.deprecatedAt !== null) {
    return { ok: false, reason: "not_found" };
  }

  if (isEmptyReferenceCodePatch(patch)) {
    return { ok: true, tenantCode: existing, noop: true };
  }

  const input = mergeReferenceCodePatchInput(existing, patch);
  const errors = validateUpdateTenantReferenceCodeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_tenant_codes
    SET sort_order = ${input.sortOrder}, metadata = ${input.metadata},
        valid_from = ${input.validFrom}, valid_to = ${input.validTo},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${existing.id} AND deprecated_at IS NULL
    RETURNING id, tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from,
      valid_to, deprecated_at, created_at, updated_at
  `) as TenantCodeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const updated = rows[0];
  await replaceTenantLabels(tx, tenantId, updated.id, input.labels);
  const tenantCode = toRow(updated, input.labels);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "reference_tenant_code",
    resourceId: tenantCode.id,
    severity: "info",
    message: `Tenant reference code "${tenantCode.code}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, tenantCode, noop: false };
}

export type DeprecateTenantReferenceCodeResult =
  | { ok: true; tenantCode: TenantReferenceCodeRow }
  | { ok: false; reason: "validation"; errors: ReferenceCodeValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deprecated" };

export async function deprecateTenantReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  tenantCodeId: string,
  input: DeprecateTenantReferenceCodeInput,
  correlationId?: string
): Promise<DeprecateTenantReferenceCodeResult> {
  const errors = validateDeprecateTenantReferenceCodeInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, deprecated_at FROM awcms_mini_reference_tenant_codes
    WHERE tenant_id = ${tenantId} AND id = ${tenantCodeId}
  `) as { id: string; deprecated_at: Date | null }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deprecated_at !== null) {
    return { ok: false, reason: "already_deprecated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_tenant_codes
    SET deprecated_at = now(), deprecated_by = ${actorTenantUserId},
        deprecate_reason = ${input.reason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${tenantCodeId} AND deprecated_at IS NULL
    RETURNING id, tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from,
      valid_to, deprecated_at, created_at, updated_at
  `) as TenantCodeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deprecated" };
  }

  const labelsById = await fetchLabelsByTenantCodeIds(tx, [rows[0].id]);
  const tenantCode = toRow(rows[0], labelsById.get(rows[0].id) ?? []);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_TENANT_CODE_DEPRECATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_tenant_code",
    aggregateId: tenantCode.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { code: tenantCode.code, reason: input.reason }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "reference_tenant_code",
    resourceId: tenantCode.id,
    severity: "warning",
    message: `Tenant reference code "${tenantCode.code}" deprecated.`,
    attributes: { reason: input.reason },
    correlationId
  });

  return { ok: true, tenantCode };
}

export type RestoreTenantReferenceCodeResult =
  | { ok: true; tenantCode: TenantReferenceCodeRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deprecated" };

export async function restoreTenantReferenceCode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  tenantCodeId: string,
  correlationId?: string
): Promise<RestoreTenantReferenceCodeResult> {
  const existingRows = (await tx`
    SELECT id, deprecated_at FROM awcms_mini_reference_tenant_codes
    WHERE tenant_id = ${tenantId} AND id = ${tenantCodeId}
  `) as { id: string; deprecated_at: Date | null }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deprecated_at === null) {
    return { ok: false, reason: "not_deprecated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_tenant_codes
    SET deprecated_at = NULL, deprecated_by = NULL, deprecate_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${tenantCodeId} AND deprecated_at IS NOT NULL
    RETURNING id, tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from,
      valid_to, deprecated_at, created_at, updated_at
  `) as TenantCodeDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deprecated" };
  }

  const labelsById = await fetchLabelsByTenantCodeIds(tx, [rows[0].id]);
  const tenantCode = toRow(rows[0], labelsById.get(rows[0].id) ?? []);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "reference_tenant_code",
    resourceId: tenantCode.id,
    severity: "warning",
    message: `Tenant reference code "${tenantCode.code}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, tenantCode };
}

export async function fetchTenantReferenceCodeById(
  tx: Bun.SQL,
  tenantId: string,
  tenantCodeId: string
): Promise<TenantReferenceCodeRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from,
      valid_to, deprecated_at, created_at, updated_at
    FROM awcms_mini_reference_tenant_codes
    WHERE tenant_id = ${tenantId} AND id = ${tenantCodeId}
  `) as TenantCodeDbRow[];
  if (!rows[0]) {
    return null;
  }
  const labelsById = await fetchLabelsByTenantCodeIds(tx, [rows[0].id]);
  return toRow(rows[0], labelsById.get(rows[0].id) ?? []);
}

export type ListTenantReferenceCodesFilter = {
  valueSetId?: string;
  includeDeprecated?: boolean;
};

/** Bounded list (`LIMIT 500`), tenant-scoped by construction (RLS + explicit `tenant_id` filter). */
export async function listTenantReferenceCodes(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListTenantReferenceCodesFilter = {}
): Promise<TenantReferenceCodeRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, value_set_id, base_code_id, code, sort_order, metadata, valid_from,
      valid_to, deprecated_at, created_at, updated_at
    FROM awcms_mini_reference_tenant_codes
    WHERE tenant_id = ${tenantId}
      AND (${filter.valueSetId ?? null}::uuid IS NULL OR value_set_id = ${filter.valueSetId ?? null})
      AND (${filter.includeDeprecated ?? false} OR deprecated_at IS NULL)
    ORDER BY sort_order ASC, code ASC
    LIMIT 500
  `) as TenantCodeDbRow[];

  const labelsById = await fetchLabelsByTenantCodeIds(
    tx,
    rows.map((row) => row.id)
  );
  return rows.map((row) => toRow(row, labelsById.get(row.id) ?? []));
}
