import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readFormBody
} from "../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import {
  listImportBatches,
  resolveImportDescriptor,
  stageImportBatch
} from "../../../../../modules/data-exchange/application/import-batch-directory";
import { authorizeExchangeDescriptorPermission } from "../../../../../modules/data-exchange/application/descriptor-authorization";
import type { ImportBatchStatus as _ImportBatchStatusAlias } from "../../../../../modules/data-exchange/domain/import-batch-state";

const IDEMPOTENCY_SCOPE = "data_exchange_import_stage";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "imports",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "imports",
  action: "create" as const
};

const VALID_STATUSES = new Set([
  "staged",
  "validating",
  "previewed",
  "committing",
  "committed",
  "partially_committed",
  "failed",
  "cancelled"
]);
const VALID_FORMATS = new Set(["csv", "json"]);

/** `GET /api/v1/data-exchange/imports?importKey=&status=` (Issue #752). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "status is not a recognized import batch status."
    );
  }

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

    const batches = await listImportBatches(tx, tenantId, {
      importKey: url.searchParams.get("importKey") ?? undefined,
      status: (statusParam as _ImportBatchStatusAlias | null) ?? undefined
    });

    return ok({ batches });
  });
};

/**
 * `POST /api/v1/data-exchange/imports` (Issue #752) — stages a new import
 * batch. `multipart/form-data`: `importKey`, `format` (csv|json), `file`,
 * optional `checksumSha256`. High-risk mutation: requires
 * `Idempotency-Key`. The body is capped at the `large` HTTP tier (5 MiB)
 * BEFORE any multipart parsing (`readFormBody`) — a second, descriptor-
 * specific size check happens inside `stageImportBatch` itself.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const formResult = await readFormBody(request, "large");
  if (formResult.tooLarge) return bodyTooLargeResponse(formResult.limitBytes);
  const form = formResult.value;
  if (!form) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Request body must be multipart/form-data."
    );
  }

  const importKey = form.get("importKey");
  const format = form.get("format");
  const file = form.get("file");
  const clientChecksum = form.get("checksumSha256");

  if (typeof importKey !== "string" || importKey.trim().length === 0) {
    return fail(400, "VALIDATION_ERROR", "importKey is required.");
  }
  if (typeof format !== "string" || !VALID_FORMATS.has(format)) {
    return fail(400, "VALIDATION_ERROR", 'format must be "csv" or "json".');
  }
  if (!(file instanceof Blob)) {
    return fail(400, "VALIDATION_ERROR", "file is required.");
  }

  const rawContent = await file.text();
  const originalFilename = file instanceof File ? file.name : null;
  const mediaType = file.type;
  const clientChecksumSha256 =
    typeof clientChecksum === "string" && /^[0-9a-f]{64}$/i.test(clientChecksum)
      ? clientChecksum.toLowerCase()
      : null;

  const requestHash = computeRequestHash({
    importKey,
    format,
    originalFilename,
    checksum: clientChecksumSha256
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
      CREATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    // An unknown importKey answers 404 further below (`Unknown importKey`)
    // — this route's own handling of an unresolvable descriptor, which
    // `authorizeExchangeDescriptorPermission` no longer accepts as an
    // implicit allow (Issue #820 Cacat 3).
    const stageDescriptor = resolveImportDescriptor(importKey);
    if (stageDescriptor) {
      const descriptorPermCheck = await authorizeExchangeDescriptorPermission(
        tx,
        tenantId,
        tokenHash,
        now,
        stageDescriptor
      );
      if (!descriptorPermCheck.allowed) return descriptorPermCheck.denied;
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

    const result = await stageImportBatch(
      tx,
      tenantId,
      auth.context.tenantUserId,
      {
        importKey,
        format: format as "csv" | "json",
        mediaType,
        originalFilename,
        rawContent,
        clientChecksumSha256
      },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "unknown_import_key") {
        return fail(404, "NOT_FOUND", `Unknown importKey: "${importKey}".`);
      }
      if (result.reason === "unsupported_format") {
        return fail(
          400,
          "VALIDATION_ERROR",
          `Format "${format}" is not supported for this importKey.`
        );
      }
      if (result.reason === "unsupported_media_type") {
        return fail(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          `Content-Type "${mediaType}" is not an allowed media type for format "${format}".`
        );
      }
      if (result.reason === "empty_file") {
        return fail(400, "VALIDATION_ERROR", "file must not be empty.");
      }
      if (result.reason === "file_too_large") {
        return fail(
          413,
          "PAYLOAD_TOO_LARGE",
          `file exceeds this import's maximum allowed size of ${result.limitBytes} bytes.`
        );
      }
      return fail(
        409,
        "CHECKSUM_MISMATCH",
        "The provided checksumSha256 does not match the computed checksum of the uploaded content."
      );
    }

    const successResponse = ok({ batch: result.batch });
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
