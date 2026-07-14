import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { readJsonBody } from "../../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import {
  DEFAULT_KEY_ROTATION_OVERLAP_HOURS,
  rotateIntegrationEndpointSecret
} from "../../../../../../modules/integration-hub/application/endpoint-directory";

const CONFIGURE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "endpoints",
  action: "configure" as const
};
const IDEMPOTENCY_SCOPE = "integration_hub_endpoint_rotate_secret";

type RotateSecretRequestBody = {
  newSecretReference?: unknown;
  overlapHours?: unknown;
};

/**
 * `POST /api/v1/integration-hub/endpoints/{id}/rotate-secret` — rotates an
 * inbound endpoint's HMAC secret with an overlap window (Issue #754:
 * "support key rotation with overlap"). High-risk (`configure` is in
 * `HIGH_RISK_ACTIONS`), reason not required (the new secret VALUE itself
 * is never accepted here — only a `secret_reference` pointer, same
 * convention `endpoints.create` uses), `Idempotency-Key` required (each
 * call performs a NEW rotation, not a reversible toggle).
 */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Endpoint id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<RotateSecretRequestBody>(request);
  if (bodyRead.tooLarge)
    return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  const body = bodyRead.value ?? {};
  const newSecretReference =
    typeof body.newSecretReference === "string"
      ? body.newSecretReference.trim()
      : "";

  if (!newSecretReference) {
    return fail(400, "VALIDATION_ERROR", "newSecretReference is required.");
  }

  const overlapHours =
    typeof body.overlapHours === "number" &&
    body.overlapHours > 0 &&
    body.overlapHours <= 168
      ? body.overlapHours
      : DEFAULT_KEY_ROTATION_OVERLAP_HOURS;

  const requestHash = computeRequestHash({
    id,
    newSecretReference,
    overlapHours
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
      CONFIGURE_GUARD
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

    const endpoint = await rotateIntegrationEndpointSecret(
      tx,
      tenantId,
      id,
      newSecretReference,
      auth.context.tenantUserId,
      overlapHours
    );

    if (!endpoint)
      return fail(404, "RESOURCE_NOT_FOUND", "Inbound endpoint not found.");

    // Never log/audit the secret_reference VALUE change details beyond
    // "a rotation happened" — secret_reference is a pointer, not the
    // secret itself, but the pointer string is still not audit content
    // (doc 10 masking discipline: minimize what touches the audit log).
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.endpoint.secret_rotated",
      resourceType: "integration_endpoint",
      resourceId: id,
      severity: "info",
      message: `Inbound webhook endpoint secret rotated (overlap window: ${overlapHours}h).`,
      correlationId
    });

    const successResponse = ok({ endpoint });
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
