import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../../modules/_shared/idempotency";
import { fetchReferenceValueSetByKey } from "../../../../../../../../modules/reference-data/application/value-set-directory";
import {
  fetchReferenceImportById,
  rollbackReferenceImport
} from "../../../../../../../../modules/reference-data/application/import-service";

const IDEMPOTENCY_SCOPE = "reference_data_import_rollback";

const ROLLBACK_GUARD = {
  moduleKey: "reference_data",
  activityCode: "imports",
  action: "rollback" as const
};

/**
 * `POST /api/v1/reference-data/value-sets/{key}/imports/{importId}/rollback`
 * (Issue #750) — HIGH RISK: reverts a committed import batch's cumulative
 * effect on the GLOBAL baseline. Refuses to delete a code the batch
 * created if it has since been referenced by a tenant override/extension
 * (`import-service.ts`'s own header comment — recovery-notes limitation,
 * not silently bypassed). Requires `Idempotency-Key`.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  const importId = params.importId;
  if (!key || !importId) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Value set key and import id are required."
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const requestHash = computeRequestHash({ importId, action: "rollback" });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      ROLLBACK_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    // Ownership check: the import batch resolved by {importId} must
    // actually belong to the value set named by {key} in the URL — never
    // trust importId alone (security-review finding: two distinct value
    // sets' import batches must not be confusable via a mismatched key).
    const importRecord = await fetchReferenceImportById(tx, importId);
    if (!importRecord || importRecord.valueSetId !== valueSet.id) {
      return fail(404, "NOT_FOUND", "Import batch not found.");
    }

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );
    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    const result = await rollbackReferenceImport(
      tx,
      tenantId,
      auth.context.tenantUserId,
      importId,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Import batch not found.");
      if (result.reason === "referenced_since_import") {
        return fail(
          409,
          "REFERENCED_SINCE_IMPORT",
          `Rollback blocked — code(s) created by this import are now referenced by tenant data: ${result.blockedCodeIds.join(", ")}. Deprecate them manually instead.`
        );
      }
      return fail(
        409,
        "INVALID_STATUS",
        `Import batch is not in a rollback-eligible state (status: ${result.status}).`
      );
    }

    const successResponse = ok({ import: result.import });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};
