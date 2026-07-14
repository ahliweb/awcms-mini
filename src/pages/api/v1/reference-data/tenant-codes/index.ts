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
import { fetchReferenceValueSetByKey } from "../../../../../modules/reference-data/application/value-set-directory";
import {
  createTenantReferenceCode,
  listTenantReferenceCodes
} from "../../../../../modules/reference-data/application/tenant-code-directory";
import { resolveReferenceValueSetForTenant } from "../../../../../modules/reference-data/application/reference-resolution-query";
import type { ReferenceCodeLabelInput } from "../../../../../modules/reference-data/domain/code";

const IDEMPOTENCY_SCOPE = "reference_data_tenant_code_create";

const READ_GUARD = {
  moduleKey: "reference_data",
  activityCode: "tenant_codes",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "reference_data",
  activityCode: "tenant_codes",
  action: "create" as const
};

function parseLabels(value: unknown): ReferenceCodeLabelInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object"
    )
    .map((entry) => ({
      locale: typeof entry.locale === "string" ? entry.locale : "",
      label: typeof entry.label === "string" ? entry.label : "",
      description:
        typeof entry.description === "string" ? entry.description : null
    }));
}

/**
 * `GET /api/v1/reference-data/tenant-codes?valueSet=&mode=raw|resolved&includeDeprecated=&asOf=&locale=`
 * (Issue #750). `mode=raw` (default) lists the caller's tenant's own
 * override/extension ROWS (management view). `mode=resolved` returns the
 * MERGED baseline+override effective list (`domain/resolution.ts`).
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const valueSetKey = url.searchParams.get("valueSet");
  if (!valueSetKey) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "valueSet query parameter is required."
    );
  }

  const mode = url.searchParams.get("mode") === "resolved" ? "resolved" : "raw";
  const includeDeprecated =
    url.searchParams.get("includeDeprecated") === "true";
  const asOfParam = url.searchParams.get("asOf");
  const asOf = asOfParam ? new Date(asOfParam) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    return fail(400, "VALIDATION_ERROR", "asOf must be a valid date.");
  }
  const locale = url.searchParams.get("locale") ?? "en";

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

    const valueSet = await fetchReferenceValueSetByKey(tx, valueSetKey);
    if (!valueSet) return fail(404, "NOT_FOUND", "Value set not found.");

    if (mode === "resolved") {
      const codes = await resolveReferenceValueSetForTenant(
        tx,
        tenantId,
        valueSet.id,
        {
          asOf,
          locale,
          includeDeprecated
        }
      );
      return ok({ codes });
    }

    const tenantCodes = await listTenantReferenceCodes(tx, tenantId, {
      valueSetId: valueSet.id,
      includeDeprecated
    });
    return ok({ tenantCodes });
  });
};

/**
 * `POST /api/v1/reference-data/tenant-codes` — creates a TENANT-SCOPED
 * override (`baseCodeId` set) or extension (`baseCodeId` null), gated by
 * the value set's `overridePolicy` (server-side, `domain/tenant-code.ts`).
 * Requires `Idempotency-Key`.
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

  const valueSetKey = typeof body.valueSet === "string" ? body.valueSet : "";
  if (!valueSetKey) {
    return fail(400, "VALIDATION_ERROR", "valueSet is required.");
  }

  const input = {
    baseCodeId: typeof body.baseCodeId === "string" ? body.baseCodeId : null,
    code: typeof body.code === "string" ? body.code : "",
    labels: parseLabels(body.labels),
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    metadata:
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : {},
    validFrom:
      typeof body.validFrom === "string"
        ? new Date(body.validFrom)
        : new Date(),
    validTo: typeof body.validTo === "string" ? new Date(body.validTo) : null
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

    const valueSet = await fetchReferenceValueSetByKey(tx, valueSetKey);
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

    const result = await createTenantReferenceCode(
      tx,
      tenantId,
      auth.context.tenantUserId,
      valueSet.id,
      valueSet.overridePolicy,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "base_code_not_found") {
        return fail(
          404,
          "NOT_FOUND",
          "baseCodeId does not reference an existing code in this value set."
        );
      }
      if (result.reason === "code_mismatch_with_base_code") {
        return fail(
          409,
          "CODE_MISMATCH_WITH_BASE_CODE",
          `An override must restate the SAME code as its base code ("${result.baseCode}"), not a different one.`
        );
      }
      if (result.reason === "code_collides_with_baseline") {
        return fail(
          409,
          "CODE_COLLIDES_WITH_BASELINE",
          "This code already exists in the global baseline -- create an override (with baseCodeId set) instead of an extension."
        );
      }
      if (result.reason === "duplicate_code") {
        return fail(
          409,
          "DUPLICATE_CODE",
          "A tenant code with this value already exists in this value set."
        );
      }
      if (result.reason === "policy_forbids_kind") {
        return fail(
          403,
          "POLICY_FORBIDS_KIND",
          `This value set's override policy does not allow a tenant ${result.kind}.`
        );
      }
      if (result.reason === "value_set_not_found") {
        return fail(404, "NOT_FOUND", "Value set not found.");
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ tenantCode: result.tenantCode });
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
