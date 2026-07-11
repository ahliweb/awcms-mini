import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../lib/security/request-body-limit";
import { extractBearerToken } from "../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../modules/identity-access/application/decision-log";
import {
  evaluateAccess,
  type AccessRequest
} from "../../../../modules/identity-access/domain/access-control";

type EvaluateBody = Partial<AccessRequest>;

export const POST: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<EvaluateBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const body = bodyRead.value;

  if (
    !body ||
    typeof body.moduleKey !== "string" ||
    typeof body.activityCode !== "string" ||
    typeof body.action !== "string"
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "moduleKey, activityCode, and action are required."
    );
  }

  const accessRequest: AccessRequest = {
    moduleKey: body.moduleKey,
    activityCode: body.activityCode,
    action: body.action as AccessRequest["action"],
    resourceType: body.resourceType,
    resourceId: body.resourceId,
    resourceAttributes: body.resourceAttributes,
    environmentAttributes: body.environmentAttributes
  };

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

    if (!context) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const grantedPermissionKeys = await fetchGrantedPermissionKeys(
      tx,
      tenantId,
      context.tenantUserId
    );
    const decision = evaluateAccess(
      context,
      accessRequest,
      grantedPermissionKeys
    );

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      accessRequest,
      decision
    );

    return ok({
      allowed: decision.allowed,
      reason: decision.reason,
      matchedPolicy: decision.matchedPolicy
    });
  });
};
