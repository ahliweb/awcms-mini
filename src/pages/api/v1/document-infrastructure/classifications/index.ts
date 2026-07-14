import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
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
  createClassification,
  listClassifications
} from "../../../../../modules/document-infrastructure/application/document-classification-directory";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "classifications",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "classifications",
  action: "create" as const
};

type CreateClassificationBody = {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  confidentialityLevel?: unknown;
  retentionReference?: unknown;
};

/** `GET /api/v1/document-infrastructure/classifications?status=` (Issue #751). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  if (statusParam && statusParam !== "active" && statusParam !== "inactive") {
    return fail(400, "VALIDATION_ERROR", "status must be active or inactive.");
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

    const classifications = await listClassifications(tx, tenantId, {
      status: statusParam as "active" | "inactive" | undefined
    });

    return ok({ classifications });
  });
};

/** `POST /api/v1/document-infrastructure/classifications` (Issue #751) — not idempotent (low-risk admin-config-create, same class as `organization-structure/legal-entities` POST). */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const bodyRead = await readJsonBody<CreateClassificationBody>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    code: typeof body.code === "string" ? body.code : "",
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : null,
    confidentialityLevel:
      typeof body.confidentialityLevel === "string"
        ? body.confidentialityLevel
        : "internal",
    retentionReference:
      typeof body.retentionReference === "string"
        ? body.retentionReference
        : null
  };

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

    const result = await createClassification(
      tx,
      tenantId,
      auth.context.tenantUserId,
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

    return ok({ classification: result.classification });
  });
};
