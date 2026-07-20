/**
 * `provisioning_status` capability adapter (Issue #872, epic #868, ADR-0022
 * §2). `tenant_provisioning` PROVIDES this read-only port so a downstream
 * module (#873 tenant lifecycle) or operator surface can observe a run WITHOUT
 * importing this module's application/domain (enforced by
 * `tests/unit/module-boundary.test.ts`). FAIL-SAFE: a tenant with no run, a
 * disabled/unprovisioned module, or a read error resolves to a `none`/not-ready
 * snapshot — never a falsely-ready one (mirrors the fail-closed discipline of
 * the entitlement port). Bound to an already tenant-scoped `tx`.
 */
import { log } from "../../../lib/logging/logger";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import type {
  ProvisioningReadinessState,
  ProvisioningRunStatus,
  ProvisioningStatusPort,
  ProvisioningStatusSnapshot
} from "../../_shared/ports/provisioning-status-port";
import { findRequestByTenant } from "./provisioning-directory";

const MODULE_KEY = "tenant_provisioning";

function noneSnapshot(tenantId: string): ProvisioningStatusSnapshot {
  return {
    tenantId,
    status: "none",
    readiness: "pending",
    ready: false,
    planKey: null,
    planVersion: null,
    totalSteps: 0,
    completedSteps: 0,
    currentStepKey: null,
    blockedReason: null
  };
}

export function createProvisioningStatusPort(
  tx: Bun.SQL,
  tenantId: string
): ProvisioningStatusPort {
  let cached: Promise<ProvisioningStatusSnapshot> | null = null;

  function resolveOnce(): Promise<ProvisioningStatusSnapshot> {
    if (!cached) cached = resolveFailSafe();
    return cached;
  }

  async function resolveFailSafe(): Promise<ProvisioningStatusSnapshot> {
    try {
      const enabled = await resolveModuleEnabled(tx, tenantId, MODULE_KEY);
      if (!enabled) return noneSnapshot(tenantId);
      const request = await findRequestByTenant(tx, tenantId);
      if (!request) return noneSnapshot(tenantId);
      const status = request.status as ProvisioningRunStatus;
      const readiness = request.readiness as ProvisioningReadinessState;
      return {
        tenantId,
        status,
        readiness,
        ready: status === "provisioned" && readiness === "ready",
        planKey: request.planKey,
        planVersion: request.planVersion,
        totalSteps: request.totalSteps,
        completedSteps: request.completedSteps,
        currentStepKey: request.currentStepKey,
        blockedReason: request.blockedReason
      };
    } catch (error) {
      log("error", "tenant_provisioning.status_read_failed", {
        moduleKey: MODULE_KEY,
        tenantId,
        errorName: error instanceof Error ? error.name : "unknown"
      });
      return noneSnapshot(tenantId);
    }
  }

  return {
    async getStatus(): Promise<ProvisioningStatusSnapshot> {
      return resolveOnce();
    },
    async isReady(): Promise<boolean> {
      return (await resolveOnce()).ready;
    }
  };
}
