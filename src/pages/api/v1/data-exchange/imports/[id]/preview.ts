import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  getImportBatchById,
  resolveImportDescriptor
} from "../../../../../../modules/data-exchange/application/import-batch-directory";
import {
  countStagedRows,
  listStagedRows,
  maskSensitiveFields,
  PREVIEW_PAGE_SIZE_DEFAULT,
  PREVIEW_PAGE_SIZE_MAX,
  type StagedRowRow
} from "../../../../../../modules/data-exchange/application/staged-row-directory";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "imports",
  action: "read" as const
};
const RAW_VALUE_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "preview_errors",
  action: "read" as const
};

const VALID_PROPOSED_ACTIONS = new Set([
  "create",
  "update",
  "skip",
  "conflict",
  "invalid"
]);

/**
 * `GET /api/v1/data-exchange/imports/{id}/preview?proposedAction=&offset=&limit=`
 * (Issue #752) — paginated preview of staged rows, zero domain mutation.
 * Sensitive fields (per the descriptor's `sensitiveFields`) are masked
 * unless the caller ALSO holds `data_exchange.preview_errors.read` (Issue
 * #752 security requirement: raw invalid values require explicit
 * permission).
 */
export const GET: APIRoute = async ({ request, cookies, params, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const batchId = params.id;
  if (!batchId)
    return fail(400, "VALIDATION_ERROR", "id path parameter is required.");

  const proposedActionParam = url.searchParams.get("proposedAction");
  if (proposedActionParam && !VALID_PROPOSED_ACTIONS.has(proposedActionParam)) {
    return fail(400, "VALIDATION_ERROR", "proposedAction is not recognized.");
  }

  const offsetParam = Number(url.searchParams.get("offset") ?? "0");
  const limitParam = Number(
    url.searchParams.get("limit") ?? String(PREVIEW_PAGE_SIZE_DEFAULT)
  );
  const offset =
    Number.isFinite(offsetParam) && offsetParam >= 0
      ? Math.floor(offsetParam)
      : 0;
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), PREVIEW_PAGE_SIZE_MAX)
      : PREVIEW_PAGE_SIZE_DEFAULT;

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      READ_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const batch = await getImportBatchById(tx, tenantId, batchId);
    if (!batch) return fail(404, "NOT_FOUND", "Import batch not found.");

    const descriptor = resolveImportDescriptor(batch.importKey);
    const sensitiveFieldNames = descriptor?.sensitiveFields?.fieldNames ?? [];

    let canSeeRawValues = sensitiveFieldNames.length === 0;
    if (!canSeeRawValues) {
      const rawValueAuth = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        RAW_VALUE_GUARD
      );
      canSeeRawValues = rawValueAuth.allowed;
    }

    const proposedAction =
      (proposedActionParam as StagedRowRow["proposedAction"] | null) ??
      undefined;

    const [rows, total] = await Promise.all([
      listStagedRows(tx, tenantId, batchId, { proposedAction, offset, limit }),
      countStagedRows(tx, tenantId, batchId, proposedAction)
    ]);

    const projectedRows = canSeeRawValues
      ? rows
      : rows.map((row) => maskSensitiveFields(row, sensitiveFieldNames));

    return ok({
      rows: projectedRows,
      total,
      offset,
      limit,
      totals: {
        created: batch.createdCount,
        updated: batch.updatedCount,
        skipped: batch.skippedCount,
        conflict: batch.conflictCount,
        invalid: batch.invalidCount,
        failed: batch.failedCount
      }
    });
  });
};
