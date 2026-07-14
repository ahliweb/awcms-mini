/**
 * Reference value-set persistence + audit (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021). Same "not-found/invalid-state is a
 * discriminated union, never a thrown error" convention
 * `organization-structure/application/legal-entity-directory.ts`
 * documents. Column lists are spelled out per-query (not composed via
 * `tx.unsafe()` inside a tagged template — that method is for building a
 * whole raw SQL STRING, it does not compose as an interpolated fragment
 * inside `` tx`...` ``), same convention `data-lifecycle/application/
 * legal-hold-service.ts` documents.
 *
 * `awcms_mini_reference_value_sets` is a GLOBAL table (no `tenant_id`, no
 * RLS — ADR-0021 §8) — every function below still runs inside a
 * `withTenant`-scoped transaction (the ACTING tenant user's permission
 * context) even though the row itself carries no tenant column; the
 * acting tenant id is recorded on domain events/audit entries for
 * traceability ("who changed the shared baseline"), never as a column on
 * the mutated row itself.
 *
 * Deprecation (`deprecateReferenceValueSet`) is the "delete" for this
 * resource — soft-delete only, never a hard DELETE row.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  REFERENCE_DATA_EVENT_VERSION,
  REFERENCE_DATA_VALUE_SET_CREATED_EVENT_TYPE,
  REFERENCE_DATA_VALUE_SET_DEPRECATED_EVENT_TYPE,
  REFERENCE_DATA_VALUE_SET_UPDATED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  validateCreateReferenceValueSetInput,
  validateDeprecateReferenceValueSetInput,
  validateUpdateReferenceValueSetInput,
  type CreateReferenceValueSetInput,
  type DeprecateReferenceValueSetInput,
  type ReferenceValueSetOverridePolicy,
  type ReferenceValueSetScope,
  type ReferenceValueSetStatus,
  type ReferenceValueSetValidationError,
  type UpdateReferenceValueSetInput
} from "../domain/value-set";

const MODULE_KEY = "reference_data";

export type ReferenceValueSetRow = {
  id: string;
  key: string;
  ownerModule: string;
  name: string;
  description: string | null;
  scope: ReferenceValueSetScope;
  overridePolicy: ReferenceValueSetOverridePolicy;
  validationSchema: Record<string, unknown> | null;
  managedByDescriptor: boolean;
  version: number;
  status: ReferenceValueSetStatus;
  createdAt: Date;
  updatedAt: Date;
  deprecatedAt: Date | null;
};

type ValueSetDbRow = {
  id: string;
  key: string;
  owner_module: string;
  name: string;
  description: string | null;
  scope: ReferenceValueSetScope;
  override_policy: ReferenceValueSetOverridePolicy;
  validation_schema: Record<string, unknown> | null;
  managed_by_descriptor: boolean;
  version: number;
  status: ReferenceValueSetStatus;
  created_at: Date;
  updated_at: Date;
  deprecated_at: Date | null;
};

function toRow(row: ValueSetDbRow): ReferenceValueSetRow {
  return {
    id: row.id,
    key: row.key,
    ownerModule: row.owner_module,
    name: row.name,
    description: row.description,
    scope: row.scope,
    overridePolicy: row.override_policy,
    validationSchema: row.validation_schema,
    managedByDescriptor: row.managed_by_descriptor,
    version: Number(row.version),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deprecatedAt: row.deprecated_at
  };
}

export type CreateReferenceValueSetResult =
  | { ok: true; valueSet: ReferenceValueSetRow }
  | {
      ok: false;
      reason: "validation";
      errors: ReferenceValueSetValidationError[];
    }
  | { ok: false; reason: "duplicate_key" };

export async function createReferenceValueSet(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateReferenceValueSetInput,
  correlationId?: string
): Promise<CreateReferenceValueSetResult> {
  const errors = validateCreateReferenceValueSetInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existing = (await tx`
    SELECT id FROM awcms_mini_reference_value_sets WHERE key = ${input.key}
  `) as { id: string }[];
  if (existing.length > 0) {
    return { ok: false, reason: "duplicate_key" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_reference_value_sets
      (key, owner_module, name, description, scope, override_policy, validation_schema,
       managed_by_descriptor, created_by, updated_by)
    VALUES (
      ${input.key}, ${MODULE_KEY}, ${input.name}, ${input.description}, 'platform_curated',
      ${input.overridePolicy}, ${input.validationSchema}, false, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, key, owner_module, name, description, scope, override_policy,
      validation_schema, managed_by_descriptor, version, status, created_at, updated_at, deprecated_at
  `) as ValueSetDbRow[];

  const valueSet = toRow(rows[0]!);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_VALUE_SET_CREATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_value_set",
    aggregateId: valueSet.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { key: valueSet.key, overridePolicy: valueSet.overridePolicy }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "reference_value_set",
    resourceId: valueSet.id,
    severity: "info",
    message: `Reference value set "${valueSet.key}" created (affects the GLOBAL baseline shared by every tenant).`,
    attributes: { key: valueSet.key },
    correlationId
  });

  return { ok: true, valueSet };
}

export type UpdateReferenceValueSetResult =
  | { ok: true; valueSet: ReferenceValueSetRow }
  | {
      ok: false;
      reason: "validation";
      errors: ReferenceValueSetValidationError[];
    }
  | { ok: false; reason: "not_found" };

export async function updateReferenceValueSet(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  key: string,
  input: UpdateReferenceValueSetInput,
  correlationId?: string
): Promise<UpdateReferenceValueSetResult> {
  const errors = validateUpdateReferenceValueSetInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_value_sets
    SET name = ${input.name}, description = ${input.description},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE key = ${key} AND deprecated_at IS NULL
    RETURNING id, key, owner_module, name, description, scope, override_policy,
      validation_schema, managed_by_descriptor, version, status, created_at, updated_at, deprecated_at
  `) as ValueSetDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const valueSet = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_VALUE_SET_UPDATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_value_set",
    aggregateId: valueSet.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { key: valueSet.key }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "reference_value_set",
    resourceId: valueSet.id,
    severity: "info",
    message: `Reference value set "${valueSet.key}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, valueSet };
}

export type DeprecateReferenceValueSetResult =
  | { ok: true; valueSet: ReferenceValueSetRow }
  | {
      ok: false;
      reason: "validation";
      errors: ReferenceValueSetValidationError[];
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deprecated" };

export async function deprecateReferenceValueSet(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  key: string,
  input: DeprecateReferenceValueSetInput,
  correlationId?: string
): Promise<DeprecateReferenceValueSetResult> {
  const errors = validateDeprecateReferenceValueSetInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, deprecated_at FROM awcms_mini_reference_value_sets WHERE key = ${key}
  `) as { id: string; deprecated_at: Date | null }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deprecated_at !== null) {
    return { ok: false, reason: "already_deprecated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_value_sets
    SET status = 'deprecated', deprecated_at = now(), deprecated_by = ${actorTenantUserId},
        deprecate_reason = ${input.reason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE key = ${key} AND deprecated_at IS NULL
    RETURNING id, key, owner_module, name, description, scope, override_policy,
      validation_schema, managed_by_descriptor, version, status, created_at, updated_at, deprecated_at
  `) as ValueSetDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deprecated" };
  }

  const valueSet = toRow(rows[0]);

  await appendDomainEvent(tx, tenantId, {
    eventType: REFERENCE_DATA_VALUE_SET_DEPRECATED_EVENT_TYPE,
    eventVersion: REFERENCE_DATA_EVENT_VERSION,
    aggregateType: "reference_value_set",
    aggregateId: valueSet.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { key: valueSet.key, reason: input.reason }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "reference_value_set",
    resourceId: valueSet.id,
    severity: "warning",
    message: `Reference value set "${valueSet.key}" deprecated (affects the GLOBAL baseline shared by every tenant).`,
    attributes: { reason: input.reason },
    correlationId
  });

  return { ok: true, valueSet };
}

export type RestoreReferenceValueSetResult =
  | { ok: true; valueSet: ReferenceValueSetRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deprecated" };

export async function restoreReferenceValueSet(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  key: string,
  correlationId?: string
): Promise<RestoreReferenceValueSetResult> {
  const existingRows = (await tx`
    SELECT id, deprecated_at FROM awcms_mini_reference_value_sets WHERE key = ${key}
  `) as { id: string; deprecated_at: Date | null }[];
  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deprecated_at === null) {
    return { ok: false, reason: "not_deprecated" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_reference_value_sets
    SET status = 'active', deprecated_at = NULL, deprecated_by = NULL, deprecate_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE key = ${key} AND deprecated_at IS NOT NULL
    RETURNING id, key, owner_module, name, description, scope, override_policy,
      validation_schema, managed_by_descriptor, version, status, created_at, updated_at, deprecated_at
  `) as ValueSetDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deprecated" };
  }

  const valueSet = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "reference_value_set",
    resourceId: valueSet.id,
    severity: "warning",
    message: `Reference value set "${valueSet.key}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, valueSet };
}

export async function fetchReferenceValueSetByKey(
  tx: Bun.SQL,
  key: string
): Promise<ReferenceValueSetRow | null> {
  const rows = (await tx`
    SELECT id, key, owner_module, name, description, scope, override_policy,
      validation_schema, managed_by_descriptor, version, status, created_at, updated_at, deprecated_at
    FROM awcms_mini_reference_value_sets WHERE key = ${key}
  `) as ValueSetDbRow[];
  return rows[0] ? toRow(rows[0]) : null;
}

export type ListReferenceValueSetsFilter = {
  status?: ReferenceValueSetStatus;
  scope?: ReferenceValueSetScope;
};

/** Bounded list (`LIMIT 200`), newest first — same convention `listLegalEntities` establishes. */
export async function listReferenceValueSets(
  tx: Bun.SQL,
  filter: ListReferenceValueSetsFilter = {}
): Promise<ReferenceValueSetRow[]> {
  const rows = (await tx`
    SELECT id, key, owner_module, name, description, scope, override_policy,
      validation_schema, managed_by_descriptor, version, status, created_at, updated_at, deprecated_at
    FROM awcms_mini_reference_value_sets
    WHERE (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.scope ?? null}::text IS NULL OR scope = ${filter.scope ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as ValueSetDbRow[];
  return rows.map(toRow);
}
