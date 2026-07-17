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
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import {
  createExportJob,
  listExportJobs,
  resolveExportDescriptor
} from "../../../../../modules/data-exchange/application/export-job-directory";
import { authorizeExchangeDescriptorPermission } from "../../../../../modules/data-exchange/application/descriptor-authorization";
import type { ExportJobStatus as _ExportJobStatusAlias } from "../../../../../modules/data-exchange/domain/export-job-state";

const IDEMPOTENCY_SCOPE = "data_exchange_export_create";

const READ_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "exports",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "data_exchange",
  activityCode: "exports",
  action: "create" as const
};

const VALID_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);
const VALID_FORMATS = new Set(["csv", "json"]);

/** `GET /api/v1/data-exchange/exports?exportKey=&status=` (Issue #752). */
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
      "status is not a recognized export job status."
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

    const jobs = await listExportJobs(tx, tenantId, {
      exportKey: url.searchParams.get("exportKey") ?? undefined,
      status: (statusParam as _ExportJobStatusAlias | null) ?? undefined
    });

    return ok({ jobs });
  });
};

/**
 * `POST /api/v1/data-exchange/exports` (Issue #752) — queues a new export
 * job (`{ exportKey, format, filterScope? }`). Never blocks on the actual
 * export work (runs on `bun run data-exchange:worker`). High-risk
 * mutation: requires `Idempotency-Key`.
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

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const exportKey = typeof body.exportKey === "string" ? body.exportKey : "";
  const format = typeof body.format === "string" ? body.format : "";
  const filterScope =
    body.filterScope &&
    typeof body.filterScope === "object" &&
    !Array.isArray(body.filterScope)
      ? (body.filterScope as Record<string, unknown>)
      : {};

  if (exportKey.trim().length === 0) {
    return fail(400, "VALIDATION_ERROR", "exportKey is required.");
  }
  if (!VALID_FORMATS.has(format)) {
    return fail(400, "VALIDATION_ERROR", 'format must be "csv" or "json".');
  }

  const requestHash = computeRequestHash({ exportKey, format, filterScope });
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

    // An unknown exportKey answers 404 further below (`Unknown exportKey`)
    // — this route's own handling of an unresolvable descriptor, which
    // `authorizeExchangeDescriptorPermission` no longer accepts as an
    // implicit allow (Issue #820 Cacat 3).
    const createDescriptor = resolveExportDescriptor(exportKey);
    if (createDescriptor) {
      const descriptorPermCheck = await authorizeExchangeDescriptorPermission(
        tx,
        tenantId,
        tokenHash,
        now,
        createDescriptor
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

    const result = await createExportJob(
      tx,
      tenantId,
      auth.context.tenantUserId,
      { exportKey, format: format as "csv" | "json", filterScope },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "unknown_export_key") {
        return fail(404, "NOT_FOUND", `Unknown exportKey: "${exportKey}".`);
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        `Format "${format}" is not supported for this exportKey.`
      );
    }

    const successResponse = ok({ job: result.job });
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
