/**
 * `provisioning_status` capability port (Issue #872, epic #868 SaaS control
 * plane, ADR-0022 §2). `tenant_provisioning` PROVIDES this read-only,
 * TENANT-FACING view of a tenant's provisioning run so a downstream
 * control-plane module (e.g. #873 tenant lifecycle) or an operator surface can
 * observe provisioning progress/readiness WITHOUT importing
 * `tenant_provisioning`'s application/domain code (enforced by
 * `tests/unit/module-boundary.test.ts`) and WITHOUT reading its tables
 * directly.
 *
 * It is READ-ONLY: provisioning records are mutated only by
 * `tenant_provisioning`'s own operator commands. The view carries only bounded,
 * non-sensitive fields (status, readiness, step progress) — never a provider
 * secret, owner password, or a step's raw I/O (ADR-0022 §3/§6/§8). A consumer
 * wires the adapter
 * (`tenant-provisioning/application/provisioning-status-port-adapter.ts`) at
 * its composition root, inside its own `withTenant(sql, tenantId, ...)`
 * transaction.
 */

export type ProvisioningRunStatus =
  | "none"
  | "requested"
  | "in_progress"
  | "provisioned"
  | "compensating"
  | "failed"
  | "blocked"
  | "canceled"
  | "reconciling";

export type ProvisioningReadinessState = "pending" | "ready" | "blocked";

/**
 * A bounded, tenant-facing snapshot of a tenant's provisioning run.
 * `status: "none"` means the tenant has no provisioning run (e.g. it was
 * created outside the control plane). `ready` is true ONLY when the run is
 * `provisioned` AND readiness passed — the single fact a lifecycle module needs
 * to decide whether a tenant may become active.
 */
export type ProvisioningStatusSnapshot = {
  tenantId: string;
  status: ProvisioningRunStatus;
  readiness: ProvisioningReadinessState;
  /** True only when `status === "provisioned"` and `readiness === "ready"`. */
  ready: boolean;
  planKey: string | null;
  planVersion: number | null;
  totalSteps: number;
  completedSteps: number;
  currentStepKey: string | null;
  /** Present only when the run is blocked/failed — a safe, non-sensitive reason. */
  blockedReason: string | null;
};

export type ProvisioningStatusPort = {
  /** Fail-safe: a tenant with no run (or an unreadable/disabled module) returns a `none`/not-ready snapshot — never a falsely-ready one. */
  getStatus(): Promise<ProvisioningStatusSnapshot>;
  /** Convenience: `true` only when the run is provisioned AND ready. */
  isReady(): Promise<boolean>;
};
