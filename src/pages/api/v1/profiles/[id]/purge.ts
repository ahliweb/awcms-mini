import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../../modules/identity-access/domain/access-control";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";

const GUARD_REQUEST = {
  moduleKey: "profile_identity",
  activityCode: "profile_management",
  action: "purge" as const
};

const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

/**
 * `POST /api/v1/profiles/{id}/purge` (Issue 10.1). Guarded by the newly
 * added `purge` ABAC action. A genuine hard `DELETE FROM
 * awcms_mini_profiles`. Requires the profile to already be soft-deleted
 * (400 otherwise). Several other tables reference `profile_id`/
 * `source_profile_id`/`target_profile_id` with no `ON DELETE CASCADE`
 * (`awcms_mini_identities`, `awcms_mini_profile_identifiers`,
 * `awcms_mini_profile_channels`, `awcms_mini_profile_addresses`,
 * `awcms_mini_profile_entity_links`, `awcms_mini_profile_merge_requests` —
 * see `sql/003_...` and `sql/004_...`) — a foreign-key violation is caught
 * and translated into a clean `409 PURGE_BLOCKED_BY_DEPENDENTS`, never a raw
 * DB error.
 *
 * The `DELETE` runs inside `tx.savepoint(...)`, not directly on the outer
 * transaction. This matters: `withTenant` wraps the whole handler in one
 * `sql.begin(...)` transaction, and once a statement fails inside it,
 * PostgreSQL marks that transaction aborted — any later statement (including
 * an audit INSERT) would be silently discarded when the transaction is
 * eventually committed/rolled back. Wrapping the `DELETE` in a savepoint
 * means a foreign-key violation only unwinds to the savepoint, leaving the
 * outer transaction (and the ABAC decision log already written into it)
 * intact. The audit event is written **after** the outcome is known —
 * success or blocked — so it always reflects what actually happened and is
 * guaranteed to commit either way; a "before" audit would require the same
 * savepoint trick anyway for no added benefit.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
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

    if (!profile) {
      return fail(404, "RESOURCE_NOT_FOUND", "Profile not found.");
    }

    if (profile.deleted_at === null) {
      return fail(
        400,
        "PURGE_REQUIRES_SOFT_DELETE",
        "Profile must be soft-deleted before it can be purged."
      );
    }

    let blockedByDependents = false;

    try {
      await tx.savepoint(async (sp) => {
        await sp`
          DELETE FROM awcms_mini_profiles
          WHERE tenant_id = ${tenantId} AND id = ${profileId}
        `;
      });
    } catch (error) {
      if (
        error instanceof Bun.SQL.PostgresError &&
        String(error.errno) === POSTGRES_FOREIGN_KEY_VIOLATION
      ) {
        blockedByDependents = true;
      } else {
        throw error;
      }
    }

    if (blockedByDependents) {
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId: context.tenantUserId,
        moduleKey: "profile_identity",
        action: "purge",
        resourceType: "profile",
        resourceId: profileId,
        severity: "critical",
        message: "Profile purge blocked by dependent records.",
        correlationId
      });

      return fail(
        409,
        "PURGE_BLOCKED_BY_DEPENDENTS",
        "Profile cannot be purged because other records still reference it."
      );
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: context.tenantUserId,
      moduleKey: "profile_identity",
      action: "purge",
      resourceType: "profile",
      resourceId: profileId,
      severity: "critical",
      message: "Profile purged.",
      correlationId
    });

    return ok({ id: profileId, status: "purged" });
  });
};
