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
  createReferenceValueSet,
  listReferenceValueSets
} from "../../../../../modules/reference-data/application/value-set-directory";

const IDEMPOTENCY_SCOPE = "reference_data_value_set_create";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "value_sets",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "value_sets",
  action: "create" as const
};

type CreateValueSetBody = {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  overridePolicy?: unknown;
  validationSchema?: unknown;
};

/** `GET /api/v1/reference-data/value-sets?status=&scope=` (Issue #750). Reads the GLOBAL baseline catalog. */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  if (statusParam && statusParam !== "active" && statusParam !== "deprecated") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "status must be active or deprecated."
    );
  }
  const scopeParam = url.searchParams.get("scope");
  if (
    scopeParam &&
    scopeParam !== "module_contributed" &&
    scopeParam !== "platform_curated"
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "scope must be module_contributed or platform_curated."
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

    const valueSets = await listReferenceValueSets(tx, {
      status: statusParam as "active" | "deprecated" | undefined,
      scope: scopeParam as "module_contributed" | "platform_curated" | undefined
    });

    return ok({ valueSets });
  });
};

/**
 * `POST /api/v1/reference-data/value-sets` (Issue #750) — creates a
 * PLATFORM-CURATED value set only (module-contributed ones are written
 * exclusively by `contribution-sync.ts`). Writes to a GLOBAL table shared
 * by every tenant — permission `reference_data.value_sets.create` must be
 * granted narrowly (ADR-0021 §8). Requires `Idempotency-Key`: every
 * mutation in this module does, even non-destructive creates, per this
 * epic's accumulated "audit the ENTIRE mutation surface up front" lesson.
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

  const bodyRead = await readJsonBody<CreateValueSetBody>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    key: typeof body.key === "string" ? body.key : "",
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : null,
    overridePolicy:
      typeof body.overridePolicy === "string"
        ? (body.overridePolicy as
            | "none"
            | "tenant_extend"
            | "tenant_override"
            | "tenant_extend_and_override")
        : ("none" as const),
    validationSchema:
      body.validationSchema && typeof body.validationSchema === "object"
        ? (body.validationSchema as Record<string, unknown>)
        : null
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

    const result = await createReferenceValueSet(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "duplicate_key") {
        return fail(
          409,
          "DUPLICATE_KEY",
          "A value set with this key already exists."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ valueSet: result.valueSet });
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
