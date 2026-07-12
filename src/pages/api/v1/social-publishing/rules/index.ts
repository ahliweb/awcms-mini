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
  createSocialPublishRule,
  listSocialPublishRules
} from "../../../../../modules/social-publishing/application/social-publish-rule-directory";
import { fetchSocialAccountById } from "../../../../../modules/social-publishing/application/social-account-directory";
import { validateCreateSocialPublishRuleInput } from "../../../../../modules/social-publishing/domain/social-publish-rule-validation";

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

/** `GET /api/v1/social-publishing/rules` (Issue #643). */
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

    const rules = await listSocialPublishRules(tx, tenantId);

    return ok({ rules });
  });
};

/** `POST /api/v1/social-publishing/rules` (Issue #643) — create a rule. Not idempotent (same low-risk admin-config-mutation class as `ad-placement-directory.ts`'s `createAdPlacement`). `socialAccountId` is validated for existence/tenant-ownership before the row is written. */
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

  const validation = validateCreateSocialPublishRuleInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Social publish rule is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
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

    const account = await fetchSocialAccountById(
      tx,
      tenantId,
      input.socialAccountId
    );

    if (!account) {
      return fail(
        422,
        "SOCIAL_PUBLISH_RULE_ACCOUNT_INVALID",
        "socialAccountId does not reference an existing account for this tenant."
      );
    }

    const rule = await createSocialPublishRule(
      tx,
      tenantId,
      auth.context.tenantUserId,
      input,
      correlationId
    );

    log("info", "social_publishing.rule.created", {
      correlationId,
      tenantId,
      moduleKey: "social_publishing",
      ruleId: rule.id
    });

    return ok(rule);
  });
};
