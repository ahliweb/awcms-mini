import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { readJsonBody } from "../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import {
  getIntegrationEndpoint,
  softDeleteIntegrationEndpoint
} from "../../../../../modules/integration-hub/application/endpoint-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "endpoints",
  action: "read" as const
};
const DELETE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "endpoints",
  action: "delete" as const
};

const MAX_REASON_LENGTH = 500;

type DeleteRequestBody = { reason?: unknown };

export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Endpoint id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

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

    const endpoint = await getIntegrationEndpoint(tx, tenantId, id);
    if (!endpoint)
      return fail(404, "RESOURCE_NOT_FOUND", "Inbound endpoint not found.");

    return ok({ endpoint });
  });
};

/** Soft-delete — reason-required, audited. No `Idempotency-Key` required: soft-deleting an already-deleted (404) endpoint twice is naturally a no-op/404 on the second call, same "reversible toggle" reasoning as pause/resume, not "each call does new work" like create/rotate-secret. */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Endpoint id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const bodyRead = await readJsonBody<DeleteRequestBody>(request);
  if (bodyRead.tooLarge)
    return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  const reason =
    typeof bodyRead.value?.reason === "string"
      ? bodyRead.value.reason.trim()
      : "";
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `reason is required and must be 1-${MAX_REASON_LENGTH} characters.`
    );
  }

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
      DELETE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const deleted = await softDeleteIntegrationEndpoint(
      tx,
      tenantId,
      id,
      reason,
      auth.context.tenantUserId
    );

    if (!deleted)
      return fail(404, "RESOURCE_NOT_FOUND", "Inbound endpoint not found.");

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.endpoint.deleted",
      resourceType: "integration_endpoint",
      resourceId: id,
      severity: "warning",
      message: `Inbound webhook endpoint soft-deleted: ${reason}`,
      correlationId
    });

    return ok({ deleted: true });
  });
};
