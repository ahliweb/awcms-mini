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
  createLegalEntity,
  listLegalEntities
} from "../../../../../modules/organization-structure/application/legal-entity-directory";

const READ_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "legal_entities",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "legal_entities",
  action: "create" as const
};

type CreateLegalEntityBody = {
  name?: unknown;
  registrationIdentifier?: unknown;
  registrationIdentifierLabel?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
};

/** `GET /api/v1/organization-structure/legal-entities?status=` (Issue #749). */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }
  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

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
    if (!auth.allowed) {
      return auth.denied;
    }

    const legalEntities = await listLegalEntities(tx, tenantId, {
      status: statusParam as "active" | "inactive" | undefined
    });

    return ok({ legalEntities });
  });
};

/** `POST /api/v1/organization-structure/legal-entities` (Issue #749) — not idempotent (low-risk admin-config-create, same class as `social-publish-rule-directory.ts`'s `createSocialPublishRule`). */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }
  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<CreateLegalEntityBody>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const body = bodyRead.value ?? {};
  const input = {
    name: typeof body.name === "string" ? body.name : "",
    registrationIdentifier:
      typeof body.registrationIdentifier === "string"
        ? body.registrationIdentifier
        : null,
    registrationIdentifierLabel:
      typeof body.registrationIdentifierLabel === "string"
        ? body.registrationIdentifierLabel
        : null,
    effectiveFrom:
      typeof body.effectiveFrom === "string"
        ? new Date(body.effectiveFrom)
        : new Date(),
    effectiveTo:
      typeof body.effectiveTo === "string" ? new Date(body.effectiveTo) : null
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
    if (!auth.allowed) {
      return auth.denied;
    }

    const result = await createLegalEntity(
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

    return ok({ legalEntity: result.legalEntity });
  });
};
