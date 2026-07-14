/**
 * `data_exchange`'s own reference `DataExchangeAdapterPort`/
 * `DataExchangeExportSourcePort` implementation (Issue #752), proving the
 * generic mechanism end-to-end against a SELF-OWNED table
 * (`awcms_mini_data_exchange_reference_items`) — see `module.ts`'s header
 * and `reference-item-validation.ts`'s header for why this is a fixture,
 * not a real business domain.
 *
 * `proposedAction` derivation (create/update/skip/conflict):
 * - No existing row for `code` -> `create`.
 * - Existing row found, an optional `expectedValue` field is present in
 *   the source row AND does not match the CURRENT stored `value` ->
 *   `conflict` (a realistic optimistic-concurrency pattern: "only update
 *   if you saw the value you expected, otherwise flag for manual
 *   review" — proves the mechanism's conflict handling deterministically
 *   without inventing an unrealistic rule).
 * - Existing row found, every field already matches -> `skip` (no-op).
 * - Existing row found, some field differs (and no conflicting
 *   `expectedValue`) -> `update`.
 *
 * `commitRow` idempotency (Issue #752 "a worker interruption and retry do
 * not duplicate committed rows"): both the `create` and `update` branches
 * re-check current state before writing — a `create` whose target already
 * exists (a resumed commit re-processing a row the FIRST pass already
 * applied, before `awcms_mini_data_exchange_staged_rows.commit_status` was
 * updated to `'committed'`) is treated as an idempotent no-op success, not
 * a duplicate insert; an `update` already matching the desired state is
 * likewise a no-op success.
 */
import {
  auditReferenceItemCommit,
  countReferenceItems,
  createReferenceItem,
  findReferenceItemByCode,
  listReferenceItems,
  updateReferenceItem
} from "./reference-items-directory";
import { validateReferenceItemRow } from "../domain/reference-item-validation";
import type {
  DataExchangeAdapterPort,
  DataExchangeExportSourcePort,
  DataExchangeFieldMap
} from "../../_shared/ports/data-exchange-adapter-port";

const REFERENCE_ITEMS_KEY = "data_exchange.reference_items";

function readOptionalExpectedValue(row: DataExchangeFieldMap): number | null {
  const raw = row.expectedValue;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const numeric = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

export const referenceItemsImportAdapter: DataExchangeAdapterPort = {
  importKey: REFERENCE_ITEMS_KEY,
  schemaVersion: "1.0",

  async validateRow(tx, tenantId, row) {
    const parsed = validateReferenceItemRow(row);
    if (!parsed.valid) {
      return { valid: false, errors: parsed.errors };
    }

    const { fields, warnings } = parsed;
    const naturalKey = fields.code;
    const existing = await findReferenceItemByCode(tx, tenantId, fields.code);

    if (!existing) {
      return {
        valid: true,
        normalizedFields: fields,
        proposedAction: "create",
        naturalKey,
        warnings
      };
    }

    const expectedValue = readOptionalExpectedValue(row);
    if (expectedValue !== null && existing.value !== expectedValue) {
      return {
        valid: true,
        normalizedFields: fields,
        proposedAction: "conflict",
        naturalKey,
        warnings: [
          ...warnings,
          `expectedValue ${expectedValue} did not match the current stored value ${existing.value}.`
        ]
      };
    }

    const unchanged =
      existing.label === fields.label &&
      existing.value === fields.value &&
      existing.status === fields.status;

    return {
      valid: true,
      normalizedFields: fields,
      proposedAction: unchanged ? "skip" : "update",
      naturalKey,
      warnings
    };
  },

  async commitRow(tx, tenantId, row, proposedAction, naturalKey) {
    const fields = row as unknown as {
      code: string;
      label: string;
      value: number | null;
      status: "active" | "inactive";
    };

    if (proposedAction === "create") {
      const existing = await findReferenceItemByCode(tx, tenantId, naturalKey);
      if (existing) {
        return { committed: true, resourceId: existing.id, action: "skipped" };
      }

      const created = await createReferenceItem(
        tx,
        tenantId,
        fields.code,
        fields.label,
        fields.value,
        fields.status
      );
      await auditReferenceItemCommit(tx, tenantId, "create", created);

      return { committed: true, resourceId: created.id, action: "created" };
    }

    if (proposedAction === "update") {
      const existing = await findReferenceItemByCode(tx, tenantId, naturalKey);
      if (!existing) {
        return {
          committed: false,
          retryable: false,
          reason: `Target reference item "${naturalKey}" no longer exists.`
        };
      }

      const alreadyApplied =
        existing.label === fields.label &&
        existing.value === fields.value &&
        existing.status === fields.status;
      if (alreadyApplied) {
        return { committed: true, resourceId: existing.id, action: "skipped" };
      }

      const updated = await updateReferenceItem(
        tx,
        tenantId,
        existing.id,
        fields.label,
        fields.value,
        fields.status
      );
      if (!updated) {
        return {
          committed: false,
          retryable: true,
          reason: "Concurrent update race — safe to retry."
        };
      }
      await auditReferenceItemCommit(tx, tenantId, "update", updated);

      return { committed: true, resourceId: updated.id, action: "updated" };
    }

    return {
      committed: false,
      retryable: false,
      reason: `commitRow must not be called with proposedAction "${proposedAction}" (skip/conflict/invalid rows are never committed).`
    };
  }
};

export const referenceItemsExportAdapter: DataExchangeExportSourcePort = {
  exportKey: REFERENCE_ITEMS_KEY,
  schemaVersion: "1.0",

  async countRows(tx, tenantId, filterScope) {
    const status =
      typeof filterScope.status === "string"
        ? (filterScope.status as "active" | "inactive")
        : undefined;

    return countReferenceItems(tx, tenantId, status);
  },

  async fetchRowsPage(tx, tenantId, filterScope, afterCursor, limit) {
    const status =
      typeof filterScope.status === "string"
        ? (filterScope.status as "active" | "inactive")
        : undefined;

    const items = await listReferenceItems(
      tx,
      tenantId,
      status,
      afterCursor,
      limit
    );
    const rows: DataExchangeFieldMap[] = items.map((item) => ({
      code: item.code,
      label: item.label,
      value: item.value,
      status: item.status
    }));
    const nextCursor =
      items.length === limit ? (items[items.length - 1]?.code ?? null) : null;

    return { rows, nextCursor };
  }
};
