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
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../../modules/_shared/idempotency";
import { fetchReferenceValueSetByKey } from "../../../../../../../../modules/reference-data/application/value-set-directory";
import {
  commitReferenceImport,
  fetchReferenceImportById
} from "../../../../../../../../modules/reference-data/application/import-service";

const IDEMPOTENCY_SCOPE = "reference_data_import_commit";

const COMMIT_GUARD = {
  moduleKey: "reference_data",
  activityCode: "imports",
  action: "commit" as const
};

/**
 * `POST /api/v1/reference-data/value-sets/{key}/imports/{importId}/commit`
 * (Issue #750) — HIGH RISK: applies a validated import to the GLOBAL
 * baseline shared by every tenant. Re-validates checksum + destructive-
 * replace protection INSIDE the same transaction as the write
 * (`import-service.ts`'s own header comment). Requires `Idempotency-Key`
 * and the exact `checksum` the caller received from the dry-run response
 * (defense against committing anything other than what was reviewed).
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

  const bodyRead = await readJsonBody<{ checksum?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const checksum = typeof body.checksum === "string" ? body.checksum : "";
  if (!checksum) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "checksum is required (from the dry-run response)."
    );
  }

  const requestHash = computeRequestHash({
    importId,
    checksum,
    action: "commit"
  });
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
      COMMIT_GUARD
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

    const result = await commitReferenceImport(
      tx,
      tenantId,
      auth.context.tenantUserId,
      importId,
      checksum,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Import batch not found.");
      if (result.reason === "checksum_mismatch") {
        return fail(
          409,
          "CHECKSUM_MISMATCH",
          "The provided checksum does not match the validated import batch."
        );
      }
      if (result.reason === "blocked_by_referenced_codes") {
        return fail(
          409,
          "DESTRUCTIVE_REPLACE_BLOCKED",
          `Commit blocked — destructive replacement of code(s) already referenced by tenant data: ${result.blockedCodes.join(", ")}.`
        );
      }
      return fail(
        409,
        "INVALID_STATUS",
        `Import batch is not in a committable state (status: ${result.status}).`
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
