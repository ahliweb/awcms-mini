/**
 * Composition-root wiring for the `tenant_lifecycle` routes (Issue #873). This
 * leading-underscore, NON-route module is the TRUE composition root the
 * module-boundary/declared-dependency gates deliberately do not scan. It is the
 * ONLY place cross-module concrete code is imported and injected into the
 * lifecycle engine, so the module's own `application`/`domain` never imports
 * another module directly (ADR-0011 / ADR-0022 §4).
 *
 * The engine's cross-module effects are injected here:
 *   - `projectTenantStatus` — reuse `tenant_admin.setTenantStatus` so public
 *     host routing + background workers (which gate on
 *     `awcms_mini_tenants.status = 'active'`) enforce the SAME suspension the
 *     API/SSR auth chokepoint enforces, in the SAME commit (four-surface parity).
 *   - `downgradeEntitlement` — reuse the #871 `tenant_entitlement` assign path
 *     (never a duplicated copy) so a downgrade changes effective entitlement
 *     without deleting data.
 *   - `provisioningReady` — read the #872 `provisioning_status` port for restore
 *     reconciliation. All optional → a LAN/offline deployment that wires none
 *     still runs lifecycle fully (payment/provider-independent, AC).
 */
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { fail, jsonResponse } from "../../../../modules/_shared/api-response";
import {
  findIdempotencyRecord,
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../modules/_shared/idempotency";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import type { AccessAction } from "../../../../modules/identity-access/domain/access-control";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { listModules } from "../../../../modules";
import { setTenantStatus } from "../../../../modules/tenant-admin/application/tenant-onboarding";
import { createServiceCatalogReadPort } from "../../../../modules/service-catalog/application/service-catalog-read-port-adapter";
import { assignEntitlement } from "../../../../modules/tenant-entitlement/application/entitlement-directory";
import { createProvisioningStatusPort } from "../../../../modules/tenant-provisioning/application/provisioning-status-port-adapter";
import type { LifecycleEngineDeps } from "../../../../modules/tenant-lifecycle/application/lifecycle-transition";

const MODULE_KEY = "tenant_lifecycle";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Build the engine deps — reuses `tenant_admin` status projection, the #871
 * entitlement assign path, and the #872 provisioning_status port. All wired
 * against the caller's already tenant-scoped `tx`.
 */
export function buildEngineDeps(correlationId?: string): LifecycleEngineDeps {
  return {
    async projectTenantStatus(tx, tenantId, active, actor) {
      await setTenantStatus(
        tx,
        tenantId,
        active ? "active" : "inactive",
        actor
      );
    },
    async downgradeEntitlement(tx, tenantId, actor, offer) {
      const deps = {
        catalogPort: createServiceCatalogReadPort(tx),
        moduleDescriptors: listModules()
      };
      const result = await assignEntitlement(
        tx,
        tenantId,
        actor ?? tenantId,
        {
          planKey: offer.offerPlanKey,
          offerVersion: offer.offerVersion,
          source: "subscription",
          reason: "lifecycle downgrade",
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        deps,
        correlationId
      );
      if (result.ok) {
        return { ok: true, before: null, assignmentId: result.assignment.id };
      }
      if (result.reason === "offer_not_found") {
        return { ok: false, reason: "offer_not_found" };
      }
      return {
        ok: false,
        reason: result.reason === "conflict" ? "conflict" : "validation"
      };
    },
    async provisioningReady(tx, tenantId) {
      const port = createProvisioningStatusPort(tx, tenantId);
      const snapshot = await port.getStatus();
      return {
        ready: snapshot.ready,
        status: snapshot.status,
        blockedReason: snapshot.blockedReason
      };
    }
  };
}

export type OperatorAuth = {
  allowed: true;
  operatorTenantId: string;
  actorTenantUserId: string;
  correlationId?: string;
};

/**
 * Authorize the platform operator in THEIR OWN tenant context (the module must
 * be enabled + the permission granted there). The operator then operates on the
 * TARGET tenant via a per-tenant context (ADR-0022 §6(a)) — never BYPASSRLS.
 * Lifecycle is a PLATFORM-operator action, allowed ONLY from the platform
 * (setup singleton) tenant so a provisioned tenant's owner cannot reach another
 * tenant's lifecycle.
 */
export async function authorizeOperator(
  request: Request,
  cookies: import("astro").AstroCookies,
  activityCode: string,
  action: AccessAction,
  correlationId?: string
): Promise<OperatorAuth | Response> {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const result = await withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      {
        moduleKey: MODULE_KEY,
        activityCode,
        action
      }
    );
    if (!auth.allowed) return auth.denied;

    const platformRows = (await tx`
      SELECT tenant_id FROM awcms_mini_setup_state WHERE id = true
    `) as { tenant_id: string | null }[];
    const platformTenantId = platformRows[0]?.tenant_id ?? null;
    if (!platformTenantId || platformTenantId !== tenantId) {
      return fail(
        403,
        "ACCESS_DENIED",
        "Tenant lifecycle is restricted to the platform operator tenant."
      );
    }

    return {
      allowed: true as const,
      operatorTenantId: tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      correlationId
    };
  });
  return result as OperatorAuth | Response;
}

/**
 * The outcome an idempotent lifecycle mutation `execute` returns:
 *   - `success` -> persist the idempotency record (same-key replay is exact)
 *     and return the body.
 *   - `conflict` -> a deterministic business conflict (illegal transition /
 *     version conflict): first try to replay a concurrent SAME-key winner
 *     (row-lock race, memory `idempotency-hash-missing-resource-id`); otherwise
 *     return the conflict WITHOUT persisting (a corrected retry can succeed).
 */
export type MutationOutcome =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "conflict"; status: number; body: unknown };

/**
 * Run a high-risk lifecycle mutation on the TARGET tenant under its per-tenant
 * RLS context with full idempotency (doc 10): same key + same hash -> replay;
 * same key + different hash -> 409; row-lock resolves concurrency. The engine
 * command (transition/schedule/downgrade/restore), its history/event/audit, and
 * the tenant-status projection all commit in this ONE transaction.
 */
export async function runIdempotentLifecycleMutation(
  targetTenantId: string,
  scope: string,
  idempotencyKey: string,
  requestHash: string,
  execute: (tx: Bun.SQL) => Promise<MutationOutcome>
): Promise<Response> {
  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, async (tx) => {
    const existing = await findIdempotencyRecord(
      tx,
      targetTenantId,
      scope,
      idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const outcome = await execute(tx);
    if (outcome.kind === "conflict") {
      const replay = await replayConcurrentIdempotentWinner(
        tx,
        targetTenantId,
        scope,
        idempotencyKey,
        requestHash
      );
      if (replay) {
        return jsonResponse(replay.responseBody, {
          status: replay.responseStatus
        });
      }
      return jsonResponse(outcome.body, { status: outcome.status });
    }

    await saveIdempotencyRecord(
      tx,
      targetTenantId,
      scope,
      idempotencyKey,
      requestHash,
      outcome.status,
      outcome.body
    );
    return jsonResponse(outcome.body, { status: outcome.status });
  });
}

/** Plain ApiSuccess body (persisted verbatim in the idempotency store). */
export function successBody(data: unknown): {
  success: true;
  data: unknown;
  meta: Record<string, never>;
} {
  return { success: true, data, meta: {} };
}

/** Plain ApiError body (persisted verbatim in the idempotency store). */
export function errorBody(
  code: string,
  message: string
): {
  success: false;
  error: { code: string; message: string };
  meta: Record<string, never>;
} {
  return { success: false, error: { code, message }, meta: {} };
}

/** Map an engine `LifecycleResult` failure reason to an HTTP status + code + kind. */
export function lifecycleFailureResponse(reason: string): {
  status: number;
  code: string;
} {
  switch (reason) {
    case "not_found":
      return { status: 404, code: "RESOURCE_NOT_FOUND" };
    case "illegal_transition":
      return { status: 409, code: "LIFECYCLE_ILLEGAL_TRANSITION" };
    case "version_conflict":
      return { status: 409, code: "LIFECYCLE_VERSION_CONFLICT" };
    case "unresolved_reconciliation":
      return { status: 409, code: "LIFECYCLE_UNRESOLVED_RECONCILIATION" };
    case "entitlement_unavailable":
      return { status: 409, code: "LIFECYCLE_ENTITLEMENT_UNAVAILABLE" };
    case "entitlement_conflict":
      return { status: 409, code: "LIFECYCLE_ENTITLEMENT_CONFLICT" };
    default:
      return { status: 400, code: "VALIDATION_ERROR" };
  }
}
