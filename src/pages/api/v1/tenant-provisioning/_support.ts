/**
 * Composition-root wiring for the `tenant_provisioning` routes (Issue #872).
 * This file lives under `src/pages/api/**` (a leading-underscore, NON-route
 * module) — the TRUE composition root the module-boundary/declared-dependency
 * gates deliberately do not scan. It is the ONLY place cross-module concrete
 * code is imported and injected into the provisioning engine, so the module's
 * own `application`/`domain` never imports another module directly (ADR-0011 /
 * ADR-0022 §4).
 *
 * The engine reuses the shared `tenant_admin` onboarding helpers (tenant/owner/
 * office/config) and the `tenant_entitlement` assign/cancel path (#871) — never
 * a duplicated copy. Module-preset and subdomain capabilities are left UNWIRED
 * in the base (they SKIP → LAN/offline safe, AC); their injection points exist
 * for a derived application or a follow-up to wire without touching the engine.
 */
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { fail } from "../../../../modules/_shared/api-response";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import type { AccessAction } from "../../../../modules/identity-access/domain/access-control";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { listModules } from "../../../../modules";
import {
  createTenantRecordIfAbsent,
  initializeTenantSettings,
  createHeadOffice,
  createTenantOwner,
  applyTenantConfiguration,
  setTenantStatus
} from "../../../../modules/tenant-admin/application/tenant-onboarding";
import { createServiceCatalogReadPort } from "../../../../modules/service-catalog/application/service-catalog-read-port-adapter";
import {
  assignEntitlement,
  transitionAssignment
} from "../../../../modules/tenant-entitlement/application/entitlement-directory";
import type {
  CapabilityAssignResult,
  CoreStepDeps
} from "../../../../modules/tenant-provisioning/application/core-step-handlers";
import type { ProvisioningEngineDeps } from "../../../../modules/tenant-provisioning/application/provisioning-orchestrator";
import { findRequestByTenant } from "../../../../modules/tenant-provisioning/application/provisioning-directory";

const MODULE_KEY = "tenant_provisioning";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** A per-command lease owner token (opaque; correlates the run to the acting request). */
export function newLeaseOwner(): string {
  return crypto.randomUUID();
}

/** Verify the target tenant has an owner identity with credentials (the mandatory security control). */
async function verifyMandatoryControls(
  tx: Bun.SQL,
  tenantId: string
): Promise<{ ready: boolean; missing: string[] }> {
  const rows = (await tx`
    SELECT count(*)::int AS owner_count
    FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i
      ON i.id = tu.identity_id AND i.tenant_id = tu.tenant_id
    WHERE tu.tenant_id = ${tenantId}
      AND i.password_hash IS NOT NULL
  `) as { owner_count: number }[];
  const hasOwner = Number(rows[0]?.owner_count ?? 0) > 0;
  return {
    ready: hasOwner,
    missing: hasOwner ? [] : ["owner_identity_with_credentials"]
  };
}

/** Build the engine deps — reuses tenant_admin onboarding + tenant_entitlement (#871). */
export function buildEngineDeps(
  correlationId?: string
): ProvisioningEngineDeps {
  const steps: CoreStepDeps = {
    async applyConfiguration(tx, tenantId, config) {
      await applyTenantConfiguration(tx, tenantId, {
        defaultLocale: config.locale ?? undefined,
        defaultTheme: config.theme ?? undefined,
        timezone: config.timezone ?? undefined
      });
    },
    async setTenantActive(tx, tenantId, actorTenantUserId) {
      await setTenantStatus(tx, tenantId, "active", actorTenantUserId);
    },
    verifyMandatoryControls,
    // #871 entitlement assignment (real reuse via the tenant_entitlement path).
    entitlement: {
      async assign(
        tx,
        tenantId,
        actorTenantUserId,
        offer
      ): Promise<CapabilityAssignResult> {
        const deps = {
          catalogPort: createServiceCatalogReadPort(tx),
          moduleDescriptors: listModules()
        };
        const result = await assignEntitlement(
          tx,
          tenantId,
          actorTenantUserId ?? tenantId,
          {
            planKey: offer.offerPlanKey,
            offerVersion: offer.offerVersion,
            source: "subscription",
            reason: "provisioning",
            effectiveFrom: null,
            effectiveTo: null,
            trialEndsAt: null,
            graceEndsAt: null
          },
          deps,
          correlationId
        );
        if (result.ok) return { ok: true, assignmentId: result.assignment.id };
        if (result.reason === "offer_not_found") {
          return { ok: false, reason: "offer_not_found" };
        }
        return {
          ok: false,
          reason: result.reason === "conflict" ? "conflict" : "validation"
        };
      },
      async cancel(tx, tenantId, actorTenantUserId, assignmentId) {
        const deps = {
          catalogPort: createServiceCatalogReadPort(tx),
          moduleDescriptors: listModules()
        };
        await transitionAssignment(
          tx,
          tenantId,
          actorTenantUserId ?? tenantId,
          assignmentId,
          "canceled",
          "provisioning compensation",
          deps,
          correlationId
        );
      }
    }
    // modulePreset / subdomain: intentionally unwired in the base (steps SKIP →
    // LAN/offline safe). A derived app wires them via these same deps.
  };

  return {
    onboarding: {
      createTenantIfAbsent: (tx, input) =>
        createTenantRecordIfAbsent(tx, {
          tenantCode: input.tenantCode,
          tenantName: input.tenantName,
          legalName: input.legalName,
          defaultLocale: input.defaultLocale ?? undefined,
          status: "inactive",
          createdBy: input.createdBy
        }),
      initTenantSettings: (tx, tenantId) =>
        initializeTenantSettings(tx, tenantId),
      createHeadOffice: (tx, tenantId, input) =>
        createHeadOffice(tx, tenantId, {
          officeCode: input.officeCode,
          officeName: input.officeName,
          createdBy: input.createdBy
        }),
      createOwner: (tx, tenantId, input) =>
        createTenantOwner(tx, tenantId, {
          ownerDisplayName: input.ownerDisplayName,
          ownerLoginIdentifier: input.ownerLoginIdentifier,
          ownerPassword: input.ownerPassword,
          createdBy: input.createdBy
        })
    },
    steps
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

    // Platform-tenant gate (ADR-0022 §5/§6 no soft super-tenant): provisioning
    // is a PLATFORM-operator action, allowed ONLY from the platform (setup
    // singleton) tenant. A provisioned tenant's owner holds every permission in
    // THEIR tenant and could enable this module there — but they are NOT the
    // platform tenant, so cross-tenant provisioning access is denied here. This
    // closes the "any tenant with the permission reads another tenant's run"
    // hole; finer operator SoD/step-up/support-access hardening is #879.
    const platformRows = (await tx`
      SELECT tenant_id FROM awcms_mini_setup_state WHERE id = true
    `) as { tenant_id: string | null }[];
    const platformTenantId = platformRows[0]?.tenant_id ?? null;
    if (!platformTenantId || platformTenantId !== tenantId) {
      return fail(
        403,
        "ACCESS_DENIED",
        "Tenant provisioning is restricted to the platform operator tenant."
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

/** Resolve the single provisioning request id for a target tenant (one run per tenant). */
export async function resolveRequestId(
  targetTenantId: string
): Promise<string | null> {
  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, async (tx) => {
    const request = await findRequestByTenant(tx, targetTenantId);
    return request ? request.id : null;
  });
}
