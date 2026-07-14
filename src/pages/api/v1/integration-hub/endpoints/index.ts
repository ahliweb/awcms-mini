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
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { readJsonBody } from "../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import {
  createIntegrationEndpoint,
  InvalidSecretReferenceError,
  listIntegrationEndpoints,
  UnknownInboundAdapterError
} from "../../../../../modules/integration-hub/application/endpoint-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "endpoints",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "endpoints",
  action: "create" as const
};

const IDEMPOTENCY_SCOPE = "integration_hub_endpoint_create";

type CreateEndpointRequestBody = {
  adapterKey?: unknown;
  displayName?: unknown;
  description?: unknown;
  secretReference?: unknown;
  maxBodyBytes?: unknown;
  allowedContentTypes?: unknown;
  timestampToleranceSeconds?: unknown;
};

/** `GET /api/v1/integration-hub/endpoints` — list, `POST` — register a new inbound webhook endpoint (Idempotency-Key required — creates a persistent, secret-pointer-holding resource). */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
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

    if (!auth.allowed) {
      return auth.denied;
    }

    const endpoints = await listIntegrationEndpoints(tx, tenantId);

    return ok({ endpoints });
  });
};

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const idempotencyKey = request.headers.get("idempotency-key");

  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<CreateEndpointRequestBody>(request);

  if (bodyRead.tooLarge) {
    return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  }

  const body = bodyRead.value ?? {};
  const adapterKey =
    typeof body.adapterKey === "string" ? body.adapterKey.trim() : "";
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : "";
  const secretReference =
    typeof body.secretReference === "string" ? body.secretReference.trim() : "";

  if (!adapterKey || !displayName || !secretReference) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "adapterKey, displayName, and secretReference are required."
    );
  }

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

    if (!auth.allowed) {
      return auth.denied;
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

    let endpoint;

    try {
      endpoint = await createIntegrationEndpoint(tx, tenantId, {
        adapterKey,
        displayName,
        description:
          typeof body.description === "string" ? body.description : null,
        secretReference,
        maxBodyBytes:
          typeof body.maxBodyBytes === "number" ? body.maxBodyBytes : undefined,
        allowedContentTypes: Array.isArray(body.allowedContentTypes)
          ? body.allowedContentTypes.filter(
              (entry): entry is string => typeof entry === "string"
            )
          : undefined,
        timestampToleranceSeconds:
          typeof body.timestampToleranceSeconds === "number"
            ? body.timestampToleranceSeconds
            : undefined,
        actorTenantUserId: auth.context.tenantUserId
      });
    } catch (error) {
      if (
        error instanceof UnknownInboundAdapterError ||
        error instanceof InvalidSecretReferenceError
      ) {
        return fail(400, "VALIDATION_ERROR", error.message);
      }

      throw error;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.endpoint.created",
      resourceType: "integration_endpoint",
      resourceId: endpoint.id,
      severity: "info",
      message: `Inbound webhook endpoint "${endpoint.displayName}" registered (adapter: ${endpoint.adapterKey}).`,
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
