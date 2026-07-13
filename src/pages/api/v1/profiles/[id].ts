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
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../modules/identity-access/domain/access-control";
import { recordCounter } from "../../../../lib/observability/metrics-port";
import { validateDeleteReasonRequestBody } from "../../../../modules/profile-identity/domain/lifecycle-validation";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";
import {
  fetchPartyById,
  updateParty
} from "../../../../modules/profile-identity/application/party-directory";
import { toPartyMaskedAdminDTO } from "../../../../modules/profile-identity/domain/projection";
import { validateUpdatePartyInput } from "../../../../modules/profile-identity/domain/party-validation";

const GUARD_REQUEST = {
  moduleKey: "profile_identity",
  activityCode: "profile_management",
  action: "delete" as const
};

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "profile_management",
  action: "read" as const
};

const UPDATE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "profile_management",
  action: "update" as const
};

/** `GET /api/v1/profiles/{id}` (Issue #748) — party detail, masked-administrative projection. 404 if not found or soft-deleted. */
export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
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

    const record = await fetchPartyById(tx, tenantId, profileId);

    if (!record) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    return ok(toPartyMaskedAdminDTO(record));
  });
};

/** `PATCH /api/v1/profiles/{id}` (Issue #748) — partial update (`displayName`/`legalName`/`riskLevel`/`verificationStatus`/`status`). `status` only accepts `active`/`inactive` — `merged` is set only by merge execution. */
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateUpdatePartyInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Party update input is invalid.",
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
      UPDATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const record = await updateParty(
      tx,
      tenantId,
      auth.context.tenantUserId,
      profileId,
      validation.value,
      correlationId
    );

    if (!record) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    return ok(toPartyMaskedAdminDTO(record));
  });
};

/**
 * `DELETE /api/v1/profiles/{id}` (Issue 10.1). Thin lifecycle-only endpoint —
 * full profile CRUD (create/update/list) is out of scope/backlog (Issue 2.2
 * only built schema + domain logic, no live API). This exists solely to
 * demonstrate the audit trail concretely end-to-end for soft delete.
 *
 * Body: `{ reason: string }` (required, non-empty) becomes `delete_reason`.
 * 404 (not a duplicate no-op 200) if the profile doesn't exist or is already
 * soft-deleted — idempotent-safe.
 */
export const DELETE: APIRoute = async ({ request, params, locals }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  const profileId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!profileId) {
    return fail(400, "VALIDATION_ERROR", "Profile id is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateDeleteReasonRequestBody(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Delete reason input is invalid.",
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
      GUARD_REQUEST,
      grantedPermissionKeys
    );

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      GUARD_REQUEST,
      decision
    );

    if (!decision.allowed) {
      return fail(403, "ACCESS_DENIED", decision.reason);
    }

    const profileRows = await tx`
      SELECT id, deleted_at FROM awcms_mini_profiles
      WHERE tenant_id = ${tenantId} AND id = ${profileId}
    `;
    const profile = profileRows[0] as
      { id: string; deleted_at: Date | null } | undefined;

    if (!profile || profile.deleted_at !== null) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    await tx`
      UPDATE awcms_mini_profiles
      SET deleted_at = ${now}, deleted_by = ${context.tenantUserId}, delete_reason = ${reason},
          updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${profileId}
    `;

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: context.tenantUserId,
      moduleKey: "profile_identity",
      action: "delete",
      resourceType: "profile",
      resourceId: profileId,
      severity: "warning",
      message: "Profile soft-deleted.",
      attributes: { reason },
      correlationId
    });

    recordCounter("profile_identity_party_lifecycle_total", {
      action: "archive"
    });

    return ok({ id: profileId, status: "deleted" });
  });
};
