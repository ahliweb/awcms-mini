import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import type { ExchangeSensitiveFieldPolicy } from "../../../../../../modules/_shared/module-contract";
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
  authorizeDescriptorPermissionKey,
  authorizeExchangeDescriptorPermission
} from "../../../../../../modules/data-exchange/application/descriptor-authorization";
import {
  countStagedRows,
  listStagedRows,
  maskAllFields,
  maskSensitiveFields,
  PREVIEW_OFFSET_MAX,
  PREVIEW_PAGE_SIZE_DEFAULT,
  PREVIEW_PAGE_SIZE_MAX,
  type StagedRowRow
} from "../../../../../../modules/data-exchange/application/staged-row-directory";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "imports",
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
 *
 * Raw staged values are revealed only when the batch's descriptor says so,
 * and only to a caller holding the permission THAT DESCRIPTOR names (Issue
 * #820, three composing defects — each fixed alone still left the hole):
 *
 * 1. An undeclared `sensitiveFields` policy masks everything (default-deny)
 *    instead of revealing everything (the old default-allow).
 * 2. The raw-value gate is `sensitiveFields.rawValuePermission`, the
 *    descriptor's OWN narrow permission — not the far broader hardcoded
 *    `data_exchange.preview_errors.read` this route used to check, which
 *    ignored the descriptor's declaration entirely.
 * 3. An unresolvable descriptor (owning module disabled after staging) is
 *    denied, not waved through — a batch must never get MORE open because
 *    its module was switched off.
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
  // Issue #831: `offset` had a floor but no ceiling, one line above a
  // `limit` that was already clamped correctly — `?offset=5000000` reached
  // Postgres verbatim as a deep scan.
  const offset =
    Number.isFinite(offsetParam) && offsetParam >= 0
      ? Math.min(Math.floor(offsetParam), PREVIEW_OFFSET_MAX)
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
    if (!descriptor) {
      // The batch outlived its descriptor — the owning module was disabled
      // or removed via `module_management` after staging. Its rows are the
      // owning module's data, and nothing left in the registry can say who
      // may read them raw or which of its fields are sensitive, so this
      // fails closed (Issue #820 Cacat 3: previously BOTH the descriptor
      // gate and the sensitive-field policy silently evaporated here,
      // leaving the batch strictly more exposed than while its module ran).
      return fail(
        409,
        "INVALID_STATE",
        `Import batch cannot be previewed: importKey "${batch.importKey}" is no longer registered — its owning module may be disabled.`
      );
    }

    const descriptorPermCheck = await authorizeExchangeDescriptorPermission(
      tx,
      tenantId,
      tokenHash,
      now,
      descriptor
    );
    if (!descriptorPermCheck.allowed) return descriptorPermCheck.denied;

    const policy = descriptor.sensitiveFields as
      ExchangeSensitiveFieldPolicy | undefined;

    // Default-deny (Issue #820 Cacat 1): the projection STARTS fully masked
    // and is only relaxed by an explicit declaration. A descriptor with no
    // policy at all reveals nothing and no permission unmasks it — omitting
    // the declaration must never be the permissive branch, which is exactly
    // what `canSeeRawValues = fieldNames.length === 0` used to make it. The
    // registry gate now rejects such a descriptor outright; this is defence
    // in depth for one reaching the route by any other path.
    let project: (row: StagedRowRow) => StagedRowRow = maskAllFields;

    if (policy) {
      // The descriptor's OWN permission decides (Issue #820 Cacat 2) —
      // `rawValuePermission` was validated at registration but enforced
      // nowhere, while this route checked a hardcoded, far broader
      // `data_exchange.preview_errors.read` instead, silently ignoring a
      // descriptor that named something narrow (e.g.
      // `profile_identity.identifiers.reveal_raw`).
      let canSeeRawValues = policy.fieldNames.length === 0;

      if (!canSeeRawValues && policy.rawValuePermission) {
        const rawValueAuth = await authorizeDescriptorPermissionKey(
          tx,
          tenantId,
          tokenHash,
          now,
          policy.rawValuePermission,
          "Exchange descriptor's sensitiveFields.rawValuePermission is malformed."
        );
        // A malformed key fails CLOSED loudly (500), never as a quiet mask.
        if (!rawValueAuth.allowed && rawValueAuth.denied.status === 500) {
          return rawValueAuth.denied;
        }
        canSeeRawValues = rawValueAuth.allowed;
      }
      // `fieldNames` non-empty with no `rawValuePermission` is rejected at
      // registration; if it ever reached here, "no permission named" means
      // nobody holds it — `canSeeRawValues` stays false.

      project = canSeeRawValues
        ? (row) => row
        : (row) => maskSensitiveFields(row, policy);
    }

    const proposedAction =
      (proposedActionParam as StagedRowRow["proposedAction"] | null) ??
      undefined;

    // Sequential, NOT `Promise.all` — both calls issue queries on the SAME
    // transaction/connection (`tx`), and one Postgres connection serves one
    // query at a time; running them concurrently produced a real hang in this
    // repo (see `reporting/application/projection-reconciliation.ts:89-94`).
    const rows = await listStagedRows(tx, tenantId, batchId, {
      proposedAction,
      offset,
      limit
    });
    const total = await countStagedRows(tx, tenantId, batchId, proposedAction);

    const projectedRows = rows.map(project);

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
