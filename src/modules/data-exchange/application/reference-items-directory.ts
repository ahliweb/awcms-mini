/**
 * CRUD + audit for `awcms_mini_data_exchange_reference_items` (Issue #752)
 * — the self-contained reference fixture this module's own exchange
 * adapter (`reference-items-exchange-adapter.ts`) reads and writes. Same
 * "column list repeated literally at each query site" convention as
 * `import-batch-directory.ts`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";

const MODULE_KEY = "data_exchange";

export type ReferenceItemRow = {
  id: string;
  tenantId: string;
  code: string;
  label: string;
  value: number | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type ReferenceItemDbRow = {
  id: string;
  tenant_id: string;
  code: string;
  label: string;
  value: string | number | null;
  status: "active" | "inactive";
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: ReferenceItemDbRow): ReferenceItemRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    label: row.label,
    value: row.value === null ? null : Number(row.value),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export async function findReferenceItemByCode(
  tx: Bun.SQL,
  tenantId: string,
  code: string
): Promise<ReferenceItemRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, code, label, value, status, created_at, updated_at, deleted_at
    FROM awcms_mini_data_exchange_reference_items
    WHERE tenant_id = ${tenantId} AND code = ${code} AND deleted_at IS NULL
  `) as ReferenceItemDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

export async function createReferenceItem(
  tx: Bun.SQL,
  tenantId: string,
  code: string,
  label: string,
  value: number | null,
  status: "active" | "inactive"
): Promise<ReferenceItemRow> {
  const rows = (await tx`
    INSERT INTO awcms_mini_data_exchange_reference_items
      (tenant_id, code, label, value, status)
    VALUES (${tenantId}, ${code}, ${label}, ${value}, ${status})
    RETURNING id, tenant_id, code, label, value, status, created_at, updated_at, deleted_at
  `) as ReferenceItemDbRow[];

  return toRow(rows[0]!);
}

export async function updateReferenceItem(
  tx: Bun.SQL,
  tenantId: string,
  itemId: string,
  label: string,
  value: number | null,
  status: "active" | "inactive"
): Promise<ReferenceItemRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_data_exchange_reference_items
    SET label = ${label}, value = ${value}, status = ${status}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${itemId} AND deleted_at IS NULL
    RETURNING id, tenant_id, code, label, value, status, created_at, updated_at, deleted_at
  `) as ReferenceItemDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

/** Bounded list (`LIMIT 500`) for `countRows`/`fetchRowsPage` export source use and admin visibility — newest first. */
export async function listReferenceItems(
  tx: Bun.SQL,
  tenantId: string,
  status: "active" | "inactive" | undefined,
  afterCode: string | null,
  limit: number
): Promise<ReferenceItemRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, code, label, value, status, created_at, updated_at, deleted_at
    FROM awcms_mini_data_exchange_reference_items
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
      AND (${afterCode}::text IS NULL OR code > ${afterCode})
    ORDER BY code ASC
    LIMIT ${limit}
  `) as ReferenceItemDbRow[];

  return rows.map(toRow);
}

export async function countReferenceItems(
  tx: Bun.SQL,
  tenantId: string,
  status: "active" | "inactive" | undefined
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS total
    FROM awcms_mini_data_exchange_reference_items
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
  `) as { total: number }[];

  return rows[0]?.total ?? 0;
}

/** Recorded by the commit job (worker role) on every create/update — `actorTenantUserId` is `null` here (the worker has no session subject; the batch's own `created_by` already attributes the ORIGINAL request to a human). */
export async function auditReferenceItemCommit(
  tx: Bun.SQL,
  tenantId: string,
  action: "create" | "update",
  item: ReferenceItemRow,
  correlationId?: string
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: MODULE_KEY,
    action,
    resourceType: "reference_item",
    resourceId: item.id,
    severity: "info",
    message: `Reference item "${item.code}" ${action === "create" ? "created" : "updated"} via data-exchange commit.`,
    attributes: { code: item.code },
    correlationId
  });
}
