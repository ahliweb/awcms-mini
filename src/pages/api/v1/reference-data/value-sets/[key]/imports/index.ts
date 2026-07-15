import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { fetchReferenceValueSetByKey } from "../../../../../../../modules/reference-data/application/value-set-directory";
import {
  dryRunReferenceImport,
  listReferenceImports
} from "../../../../../../../modules/reference-data/application/import-service";
import type { ImportDiffPayloadCode } from "../../../../../../../modules/reference-data/domain/import-diff";

const IDEMPOTENCY_SCOPE = "reference_data_import_dry_run";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "imports",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "imports",
  action: "create" as const
};

function parsePayloadCodes(value: unknown): ImportDiffPayloadCode[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object"
    )
    .map((entry) => ({
      code: typeof entry.code === "string" ? entry.code : "",
      labels: Array.isArray(entry.labels)
        ? entry.labels
            .filter(
              (l): l is Record<string, unknown> => !!l && typeof l === "object"
            )
            .map((l) => ({
              locale: typeof l.locale === "string" ? l.locale : "",
              label: typeof l.label === "string" ? l.label : "",
              description:
                typeof l.description === "string" ? l.description : null
            }))
        : [],
      sortOrder: typeof entry.sortOrder === "number" ? entry.sortOrder : 0,
      metadata:
        entry.metadata && typeof entry.metadata === "object"
          ? (entry.metadata as Record<string, unknown>)
          : {},
      validFrom:
        typeof entry.validFrom === "string"
          ? entry.validFrom
          : new Date().toISOString().slice(0, 10),
      validTo: typeof entry.validTo === "string" ? entry.validTo : null,
      replace: entry.replace === true
    }));
}

/** `GET /api/v1/reference-data/value-sets/{key}/imports` — batch history (Issue #750). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

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

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    const imports = await listReferenceImports(tx, valueSet.id);
    return ok({ imports });
  });
};

/**
 * `POST /api/v1/reference-data/value-sets/{key}/imports` — submits a
 * NON-MUTATING dry-run (issue #750: "Import dry-run/diff is non-
 * mutating"). Never touches `awcms_mini_reference_codes`; only writes an
 * `awcms_mini_reference_imports` row recording the computed diff.
 * Requires `Idempotency-Key` (this module's blanket rule for every
 * mutation, even a non-destructive one).
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const key = params.key;
  if (!key) return fail(400, "VALIDATION_ERROR", "Value set key is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{
    codes?: unknown;
    sourceProvenance?: unknown;
  }>(request, "large");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    codes: parsePayloadCodes(body.codes),
    sourceProvenance:
      typeof body.sourceProvenance === "string" ? body.sourceProvenance : null
  };

  const requestHash = computeRequestHash(body);
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

    const valueSet = await fetchReferenceValueSetByKey(tx, key);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

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

    const result = await dryRunReferenceImport(
      tx,
      tenantId,
      auth.context.tenantUserId,
      valueSet.id,
      input,
      correlationId
    );

    if (!result.ok) {
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ import: result.import, diff: result.diff });
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
