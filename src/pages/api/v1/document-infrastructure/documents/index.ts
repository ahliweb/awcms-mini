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
  createDocument,
  listDocuments
} from "../../../../../modules/document-infrastructure/application/document-directory";

const IDEMPOTENCY_SCOPE = "document_infrastructure_document_create";

const READ_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "documents",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "documents",
  action: "create" as const
};

type CreateDocumentBody = {
  ownerModuleKey?: unknown;
  documentType?: unknown;
  classificationId?: unknown;
  title?: unknown;
  summary?: unknown;
  issuedAt?: unknown;
  effectiveAt?: unknown;
  confidentialityLevel?: unknown;
  retentionReference?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
};

/** `GET /api/v1/document-infrastructure/documents` — filters: `status`, `ownerModuleKey`, `resourceType`, `resourceId` (Issue #751). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const statusParam = url.searchParams.get("status");
  const allowedStatuses = ["active", "superseded", "archived", "void"];
  if (statusParam && !allowedStatuses.includes(statusParam)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `status must be one of: ${allowedStatuses.join(", ")}.`
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

    const documents = await listDocuments(tx, tenantId, {
      status: statusParam as
        "active" | "superseded" | "archived" | "void" | undefined,
      ownerModuleKey: url.searchParams.get("ownerModuleKey") ?? undefined,
      resourceType: url.searchParams.get("resourceType") ?? undefined,
      resourceId: url.searchParams.get("resourceId") ?? undefined
    });

    return ok({ documents });
  });
};

/**
 * `POST /api/v1/document-infrastructure/documents` (Issue #751) —
 * creates a document registry entry. High-risk mutation: requires
 * `Idempotency-Key` — deliberately idempotency-gated even though plain
 * `create` is not in `HIGH_RISK_ACTIONS` (issue #751's own explicit
 * warning: a sibling PR in this epic needed a follow-up fix round
 * specifically because its FIRST idempotency pass missed a `create`
 * endpoint — a document registry entry anchors an append-only version
 * chain and a numbering reservation may be committed against it, so a
 * double-submit here has real downstream blast radius).
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

  const bodyRead = await readJsonBody<CreateDocumentBody>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const input = {
    ownerModuleKey:
      typeof body.ownerModuleKey === "string" ? body.ownerModuleKey : "",
    documentType:
      typeof body.documentType === "string" ? body.documentType : "",
    classificationId:
      typeof body.classificationId === "string" ? body.classificationId : null,
    title: typeof body.title === "string" ? body.title : "",
    summary: typeof body.summary === "string" ? body.summary : null,
    issuedAt:
      typeof body.issuedAt === "string" ? new Date(body.issuedAt) : null,
    effectiveAt:
      typeof body.effectiveAt === "string" ? new Date(body.effectiveAt) : null,
    confidentialityLevel:
      typeof body.confidentialityLevel === "string"
        ? body.confidentialityLevel
        : "internal",
    retentionReference:
      typeof body.retentionReference === "string"
        ? body.retentionReference
        : null,
    resourceType:
      typeof body.resourceType === "string" ? body.resourceType : "",
    resourceId: typeof body.resourceId === "string" ? body.resourceId : ""
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

    const result = await createDocument(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "classification_not_found") {
        return fail(
          422,
          "CLASSIFICATION_INVALID",
          "classificationId does not reference an existing classification for this tenant."
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

    const successResponse = ok({ document: result.document });
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
