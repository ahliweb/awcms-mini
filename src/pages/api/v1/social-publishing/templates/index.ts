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
  createSocialPublishTemplate,
  listSocialPublishTemplates
} from "../../../../../modules/social-publishing/application/social-publish-template-directory";
import { validateCreateSocialPublishTemplateInput } from "../../../../../modules/social-publishing/domain/social-publish-template-validation";

const READ_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "rules",
  action: "read" as const
};

const CONFIGURE_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "rules",
  action: "configure" as const
};

/** `GET /api/v1/social-publishing/templates` (Issue #643). Gated by `rules.read` — templates are configured alongside rules, no separate `templates.*` permission (see migration 050's header). */
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

    const templates = await listSocialPublishTemplates(tx, tenantId);

    return ok({ templates });
  });
};

/** `POST /api/v1/social-publishing/templates` (Issue #643). */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
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

  const validation = validateCreateSocialPublishTemplateInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Social publish template is invalid.",
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

    const template = await createSocialPublishTemplate(
      tx,
      tenantId,
      auth.context.tenantUserId,
      validation.value,
      correlationId
    );

    log("info", "social_publishing.template.created", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      templateId: template.id
    });

    return ok(template);
  });
};
