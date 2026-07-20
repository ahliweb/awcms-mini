/**
 * Composition-root wiring for the `subscription_billing` routes (Issue #876).
 * This leading-underscore, NON-route module is the TRUE composition root the
 * module-boundary/declared-dependency gates deliberately do not scan. It is the
 * ONLY place cross-module concrete code is imported and injected into the
 * billing engines, so the module's own `application`/`domain` never imports
 * another module directly (ADR-0011 / ADR-0022 §4):
 *   - `service_catalog_read` (#870) — bind subscriptions to immutable published
 *     offers and price invoice lines.
 *   - `usage_aggregate` (#875) — reconcile usage-based lines to metered windows.
 *   - `lifecycle_transition` (#873) — dunning REQUESTS a lifecycle transition
 *     through the validated engine (never a direct state write). The engine's
 *     mandatory `projectTenantStatus` is wired here so a billing-driven
 *     suspension propagates to public routing + workers in one commit.
 * All optional -> a LAN/offline deployment that wires none still runs billing
 * fully (manual-payment mode, AC).
 *
 * Authorization (ADR-0022 §5/§8): WRITE routes are PLATFORM-operator only,
 * allowed ONLY from the platform (setup singleton) tenant, operating on the
 * TARGET tenant via a per-tenant context (never BYPASSRLS). READ routes allow
 * the platform operator OR the target tenant's OWN user (self-read) — a tenant
 * user reads only its own authorized commercial records and can never mutate an
 * issued invoice.
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
import { createEffectiveEntitlementPort } from "../../../../modules/tenant-entitlement/application/effective-entitlement-port-adapter";
import { buildContractRegistry } from "../../../../modules/usage-metering/application/meter-registry";
import { createUsageAggregatePort } from "../../../../modules/usage-metering/application/usage-aggregate-adapter";
import { createLifecycleTransitionPort } from "../../../../modules/tenant-lifecycle/application/lifecycle-transition-port-adapter";
import type { LifecycleEngineDeps } from "../../../../modules/tenant-lifecycle/application/lifecycle-transition";
import type { InvoiceEngineDeps } from "../../../../modules/subscription-billing/application/invoice-engine";
import type { SubscriptionEngineDeps } from "../../../../modules/subscription-billing/application/subscription-engine";
import type { ChangeEngineDeps } from "../../../../modules/subscription-billing/application/subscription-change-engine";
import type { DunningEngineDeps } from "../../../../modules/subscription-billing/application/dunning-engine";

const MODULE_KEY = "subscription_billing";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function catalogDeps(
  tx: Bun.SQL
): SubscriptionEngineDeps & ChangeEngineDeps {
  return { catalog: createServiceCatalogReadPort(tx) };
}

export function invoiceDeps(tx: Bun.SQL, tenantId: string): InvoiceEngineDeps {
  const catalog = createServiceCatalogReadPort(tx);
  const entitlementPort = createEffectiveEntitlementPort(tx, tenantId, {
    catalogPort: catalog,
    moduleDescriptors: listModules()
  });
  const usage = createUsageAggregatePort(
    tx,
    tenantId,
    buildContractRegistry(listModules()),
    entitlementPort
  );
  return { catalog, usage };
}

/** Lifecycle engine deps for the dunning path — projectTenantStatus is mandatory. */
function lifecycleEngineDeps(): LifecycleEngineDeps {
  return {
    async projectTenantStatus(tx, tenantId, active, actor) {
      await setTenantStatus(
        tx,
        tenantId,
        active ? "active" : "inactive",
        actor
      );
    }
  };
}

export function dunningDeps(
  tx: Bun.SQL,
  targetTenantId: string
): DunningEngineDeps {
  return {
    lifecycle: createLifecycleTransitionPort(
      tx,
      targetTenantId,
      lifecycleEngineDeps()
    )
  };
}

export type OperatorAuth = {
  actorTenantUserId: string;
};

async function readPlatformTenantId(tx: Bun.SQL): Promise<string | null> {
  const rows = (await tx`
    SELECT tenant_id FROM awcms_mini_setup_state WHERE id = true
  `) as { tenant_id: string | null }[];
  return rows[0]?.tenant_id ?? null;
}

/**
 * Authorize a PLATFORM operator (WRITE): the caller must be in the platform
 * (setup) tenant with the permission granted there. The operator then operates
 * on the TARGET tenant via a per-tenant context (ADR-0022 §6a) — never
 * BYPASSRLS. A provisioned tenant's own owner can never reach another tenant's
 * billing.
 */
export async function authorizeOperator(
  request: Request,
  cookies: import("astro").AstroCookies,
  activityCode: string,
  action: AccessAction
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
    const platformTenantId = await readPlatformTenantId(tx);
    if (!platformTenantId || platformTenantId !== tenantId) {
      return fail(
        403,
        "ACCESS_DENIED",
        "Subscription billing mutations are restricted to the platform operator tenant."
      );
    }
    return { actorTenantUserId: auth.context.tenantUserId };
  });
  return result as OperatorAuth | Response;
}

/**
 * Authorize a READ for a target tenant: the platform operator (from the platform
 * tenant) OR the target tenant's OWN user (self-read). Either way the read runs
 * under the TARGET tenant's RLS context, so a tenant user only ever sees its own
 * records (cross-tenant isolation, AC).
 */
export async function authorizeRead(
  request: Request,
  cookies: import("astro").AstroCookies,
  targetTenantId: string,
  activityCode: string
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
        action: "read"
      }
    );
    if (!auth.allowed) return auth.denied;
    const platformTenantId = await readPlatformTenantId(tx);
    const isPlatformOperator =
      platformTenantId !== null && platformTenantId === tenantId;
    const isSelf = tenantId === targetTenantId;
    if (!isPlatformOperator && !isSelf) {
      return fail(
        403,
        "ACCESS_DENIED",
        "You may only read your own tenant's billing records."
      );
    }
    return { actorTenantUserId: auth.context.tenantUserId };
  });
  return result as OperatorAuth | Response;
}

export type MutationOutcome =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "conflict"; status: number; body: unknown };

/**
 * Run a high-risk billing mutation on the TARGET tenant under its per-tenant RLS
 * context with full idempotency (doc 10): same key + same hash -> replay; same
 * key + different hash -> 409; row-lock resolves concurrency. The engine
 * command, its history/event/audit all commit in this ONE transaction.
 */
export async function runIdempotentBillingMutation(
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

/** Read-only helper: run a query under the target tenant context (no idempotency). */
export function withTargetTenant<T>(
  targetTenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, fn);
}

export function successBody(data: unknown): {
  success: true;
  data: unknown;
  meta: Record<string, never>;
} {
  return { success: true, data, meta: {} };
}

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

/** Map an engine failure reason to an HTTP status + code. */
export function billingFailureResponse(reason: string): {
  status: number;
  code: string;
} {
  switch (reason) {
    case "not_found":
      return { status: 404, code: "RESOURCE_NOT_FOUND" };
    case "offer_not_found":
      return { status: 404, code: "OFFER_NOT_FOUND" };
    case "illegal_transition":
      return { status: 409, code: "BILLING_ILLEGAL_TRANSITION" };
    case "version_conflict":
      return { status: 409, code: "BILLING_VERSION_CONFLICT" };
    case "conflict":
      return { status: 409, code: "BILLING_CONFLICT" };
    case "not_billable":
      return { status: 409, code: "BILLING_NOT_BILLABLE" };
    case "no_period_anchor":
      return { status: 409, code: "BILLING_NO_PERIOD_ANCHOR" };
    case "invalid_state":
      return { status: 409, code: "BILLING_INVALID_STATE" };
    case "currency_mismatch":
      return { status: 409, code: "BILLING_CURRENCY_MISMATCH" };
    case "over_credit":
      return { status: 409, code: "BILLING_OVER_CREDIT" };
    default:
      return { status: 400, code: "VALIDATION_ERROR" };
  }
}
