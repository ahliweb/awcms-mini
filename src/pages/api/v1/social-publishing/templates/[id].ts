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
import { log } from "../../../../../lib/logging/logger";
import {
  fetchSocialPublishTemplateById,
  softDeleteSocialPublishTemplate,
  updateSocialPublishTemplate
} from "../../../../../modules/social-publishing/application/social-publish-template-directory";
import { validateUpdateSocialPublishTemplateInput } from "../../../../../modules/social-publishing/domain/social-publish-template-validation";
import { validateDeleteReasonInput } from "../../../../../modules/blog-content/domain/content-validation";

const CONFIGURE_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "rules",
  action: "configure" as const
};

/** `PATCH /api/v1/social-publishing/templates/{id}` (Issue #643). */
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Template id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<Record<string, unknown>>(
    request,
    "default"
  );

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateUpdateSocialPublishTemplateInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Template update is invalid.",
      {},
      validation.errors
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
      CONFIGURE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const updated = await updateSocialPublishTemplate(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      validation.value,
      correlationId
    );

    if (!updated) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "Social publish template not found."
      );
    }

    log("info", "social_publishing.template.updated", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      templateId: id
    });

    return ok(updated);
  });
};

/** `DELETE /api/v1/social-publishing/templates/{id}` (Issue #643) — soft delete. */
export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Template id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateDeleteReasonInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "reason is required.",
      {},
      validation.errors
    );
  }

  const { reason } = validation.value;
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

    if (!auth.allowed) {
      return auth.denied;
    }

    const existing = await fetchSocialPublishTemplateById(tx, tenantId, id);

    if (!existing) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "Social publish template not found."
      );
    }

    await softDeleteSocialPublishTemplate(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      reason,
      correlationId
    );

    log("info", "social_publishing.template.deleted", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      templateId: id
    });

    return ok({ id, deleted: true });
  });
};
