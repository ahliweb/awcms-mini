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
  fetchSocialAccountById,
  updateSocialAccountAutoPublish
} from "../../../../../modules/social-publishing/application/social-account-directory";
import { validateUpdateSocialAccountAutoPublishInput } from "../../../../../modules/social-publishing/domain/social-account-validation";

const READ_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "accounts",
  action: "read" as const
};

const CONFIGURE_GUARD = {
  moduleKey: "social_publishing",
  activityCode: "rules",
  action: "configure" as const
};

/** `GET /api/v1/social-publishing/accounts/{id}` (Issue #643). */
export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Account id is required.");
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

    const account = await fetchSocialAccountById(tx, tenantId, id);

    if (!account) {
      return fail(404, "RESOURCE_NOT_FOUND", "Social account not found.");
    }

    return ok(account);
  });
};

/**
 * `PATCH /api/v1/social-publishing/accounts/{id}` (Issue #643) — toggles
 * `autoPublishEnabled` only (per-account "Auto-posting can be enabled per
 * platform/account" — issue's own required behavior). Gated by
 * `rules.configure` (this changes whether rules for this account can ever
 * fire, the same permission that governs rule configuration), not
 * `accounts.connect`/`.disconnect` (this does not touch credentials).
 */
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!id) {
    return fail(400, "VALIDATION_ERROR", "Account id is required.");
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

  const validation = validateUpdateSocialAccountAutoPublishInput(
    bodyRead.value
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Update is invalid.",
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

    const updated = await updateSocialAccountAutoPublish(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      validation.value.autoPublishEnabled,
      correlationId
    );

    if (!updated) {
      return fail(404, "RESOURCE_NOT_FOUND", "Social account not found.");
    }

    log("info", "social_publishing.account.auto_publish_updated", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      socialAccountId: id
    });

    return ok(updated);
  });
};
