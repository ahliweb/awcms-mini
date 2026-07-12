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
  fetchSocialPublishingSettings,
  updateSocialPublishingSettings
} from "../../../../../modules/social-publishing/application/social-publishing-settings-directory";

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

/** `GET /api/v1/social-publishing/settings` (Issue #643) — the tenant half of "Auto-posting can be disabled globally and per tenant". */
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

    const settings = await fetchSocialPublishingSettings(tx, tenantId);

    return ok(settings);
  });
};

/** `PATCH /api/v1/social-publishing/settings` (Issue #643) — toggles the tenant-wide auto-posting master switch. */
export const PATCH: APIRoute = async ({ request, cookies, locals }) => {
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

  const autoPublishingEnabled = bodyRead.value?.autoPublishingEnabled;

  if (typeof autoPublishingEnabled !== "boolean") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "autoPublishingEnabled is required and must be a boolean."
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

    const updated = await updateSocialPublishingSettings(
      tx,
      tenantId,
      auth.context.tenantUserId,
      autoPublishingEnabled,
      correlationId
    );

    log("info", "social_publishing.settings.updated", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      autoPublishingEnabled
    });

    return ok(updated);
  });
};
