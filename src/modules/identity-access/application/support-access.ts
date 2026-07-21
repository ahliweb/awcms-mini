/**
 * Support-access grants (Issue #879, epic #868 SaaS control plane, ADR-0022
 * §5/§6 — FIX MEDIUM-5). A platform/support operator has NO standing right to
 * read another tenant's records for troubleshooting; every cross-tenant support
 * read requires an ACTIVE grant that is:
 *   - scope-bound  — a grant is per TARGET tenant (a grant for tenant A can
 *     never authorize a read of tenant B: the row is RLS-scoped to `tenant_id`
 *     = the target, and the runtime check queries within the target's per-tenant
 *     context);
 *   - time-bound   — `expires_at` auto-expires the grant (fail-closed);
 *   - reason-bound — a mandatory reason;
 *   - approved     — by a DISTINCT actor (SoD `support_request_vs_approve`);
 *   - revocable    — an active grant can be revoked before expiry;
 *   - auditable    — request/approve/revoke and every USE are audited.
 *
 * Every function runs inside the caller's already TARGET-tenant-scoped `tx`
 * (`withTenant(sql, targetTenantId, ...)`), so RLS guarantees a grant can only
 * ever be created/read/used for the tenant whose context is active — never
 * substituted across tenants.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";

const MODULE_KEY = "identity_access";
const RESOURCE_TYPE = "support_access_grant";

export type SupportGrantRow = {
  id: string;
  tenant_id: string;
  operator_identity_id: string;
  reason: string;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export type RequestSupportAccessResult =
  | { ok: true; grantId: string }
  | { ok: false; reason: "already_live"; message: string };

/**
 * MAKER — request a support-access grant for the active target tenant. A live
 * (requested/approved-not-revoked) grant for the same operator blocks a stack.
 */
export async function requestSupportAccess(
  tx: Bun.SQL,
  targetTenantId: string,
  input: {
    operatorIdentityId: string;
    reason: string;
    requestedBy: string | null;
    correlationId?: string | null;
  }
): Promise<RequestSupportAccessResult> {
  const rows = (await tx`
    INSERT INTO awcms_mini_control_plane_support_access_grants
      (tenant_id, operator_identity_id, reason, status, requested_by, correlation_id)
    VALUES (
      ${targetTenantId}, ${input.operatorIdentityId}, ${input.reason}, 'requested',
      ${input.requestedBy}, ${input.correlationId ?? null}
    )
    ON CONFLICT (tenant_id, operator_identity_id)
      WHERE status IN ('requested', 'approved') AND revoked_at IS NULL
    DO NOTHING
    RETURNING id
  `) as { id: string }[];

  if (rows.length === 0) {
    return {
      ok: false,
      reason: "already_live",
      message: "A live support-access grant for this operator already exists."
    };
  }

  await recordAuditEvent(tx, {
    tenantId: targetTenantId,
    actorTenantUserId: input.requestedBy ?? undefined,
    moduleKey: MODULE_KEY,
    action: "request",
    resourceType: RESOURCE_TYPE,
    resourceId: rows[0]!.id,
    severity: "warning",
    message: `Support-access requested for tenant ${targetTenantId}: ${input.reason}`,
    attributes: { operatorIdentityId: input.operatorIdentityId },
    correlationId: input.correlationId ?? undefined
  });

  return { ok: true, grantId: rows[0]!.id };
}

export type ApproveSupportAccessResult =
  | { ok: true; expiresAt: string }
  | { ok: false; reason: "not_found" | "not_requested"; message: string };

/**
 * CHECKER — approve a requested grant (a DIFFERENT actor than the requester,
 * enforced by the SoD chokepoint at the high-risk `approve` action). Sets the
 * auto-expiry window `now + ttlSeconds`.
 */
export async function approveSupportAccess(
  tx: Bun.SQL,
  targetTenantId: string,
  grantId: string,
  input: {
    approverTenantUserId: string | null;
    ttlSeconds: number;
    now: Date;
    correlationId?: string | null;
  }
): Promise<ApproveSupportAccessResult> {
  const expiresAt = new Date(
    input.now.getTime() + input.ttlSeconds * 1000
  ).toISOString();

  const rows = (await tx`
    UPDATE awcms_mini_control_plane_support_access_grants
    SET status = 'approved', approved_by = ${input.approverTenantUserId},
        approved_at = now(), expires_at = ${expiresAt}, updated_at = now()
    WHERE tenant_id = ${targetTenantId} AND id = ${grantId} AND status = 'requested'
    RETURNING id
  `) as { id: string }[];

  if (rows.length === 0) {
    const exists = (await tx`
      SELECT status FROM awcms_mini_control_plane_support_access_grants
      WHERE tenant_id = ${targetTenantId} AND id = ${grantId}
    `) as { status: string }[];
    if (exists.length === 0) {
      return { ok: false, reason: "not_found", message: "Grant not found." };
    }
    return {
      ok: false,
      reason: "not_requested",
      message: `Only a requested grant can be approved (is "${exists[0]!.status}").`
    };
  }

  await recordAuditEvent(tx, {
    tenantId: targetTenantId,
    actorTenantUserId: input.approverTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "approve",
    resourceType: RESOURCE_TYPE,
    resourceId: grantId,
    severity: "warning",
    message: `Support-access approved for tenant ${targetTenantId} (expires ${expiresAt}).`,
    attributes: { expiresAt },
    correlationId: input.correlationId ?? undefined
  });

  return { ok: true, expiresAt };
}

export type RevokeSupportAccessResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_active"; message: string };

/** Revoke an active (approved, non-revoked) grant before its expiry. */
export async function revokeSupportAccess(
  tx: Bun.SQL,
  targetTenantId: string,
  grantId: string,
  input: {
    revokerTenantUserId: string | null;
    correlationId?: string | null;
  }
): Promise<RevokeSupportAccessResult> {
  const rows = (await tx`
    UPDATE awcms_mini_control_plane_support_access_grants
    SET status = 'revoked', revoked_by = ${input.revokerTenantUserId},
        revoked_at = now(), updated_at = now()
    WHERE tenant_id = ${targetTenantId} AND id = ${grantId}
      AND status = 'approved' AND revoked_at IS NULL
    RETURNING id
  `) as { id: string }[];

  if (rows.length === 0) {
    const exists = (await tx`
      SELECT status FROM awcms_mini_control_plane_support_access_grants
      WHERE tenant_id = ${targetTenantId} AND id = ${grantId}
    `) as { status: string }[];
    if (exists.length === 0) {
      return { ok: false, reason: "not_found", message: "Grant not found." };
    }
    return {
      ok: false,
      reason: "not_active",
      message: `Only an active approved grant can be revoked (is "${exists[0]!.status}").`
    };
  }

  await recordAuditEvent(tx, {
    tenantId: targetTenantId,
    actorTenantUserId: input.revokerTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "revoke",
    resourceType: RESOURCE_TYPE,
    resourceId: grantId,
    severity: "warning",
    message: `Support-access revoked for tenant ${targetTenantId}.`,
    correlationId: input.correlationId ?? undefined
  });

  return { ok: true };
}

/**
 * The RUNTIME gate. Returns true iff there is an ACTIVE grant (approved,
 * non-revoked, non-expired) for THIS target tenant + operator. Fail-closed:
 * expiry and revocation both remove the grant. Because the query runs inside the
 * target tenant's RLS context, a grant issued for another tenant is invisible
 * here — a grant is never reusable across tenants.
 */
export async function hasActiveSupportGrant(
  tx: Bun.SQL,
  targetTenantId: string,
  operatorIdentityId: string,
  now: Date
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1
    FROM awcms_mini_control_plane_support_access_grants
    WHERE tenant_id = ${targetTenantId}
      AND operator_identity_id = ${operatorIdentityId}
      AND status = 'approved'
      AND revoked_at IS NULL
      AND expires_at > ${now.toISOString()}
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

export async function listSupportGrants(
  tx: Bun.SQL,
  targetTenantId: string
): Promise<SupportGrantRow[]> {
  return (await tx`
    SELECT id, tenant_id, operator_identity_id, reason, status, approved_by,
           approved_at, expires_at, revoked_at
    FROM awcms_mini_control_plane_support_access_grants
    WHERE tenant_id = ${targetTenantId}
    ORDER BY created_at DESC
    LIMIT 200
  `) as SupportGrantRow[];
}
