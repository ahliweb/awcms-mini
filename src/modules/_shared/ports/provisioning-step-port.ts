/**
 * `provisioning_step` capability port (Issue #872, epic #868 SaaS control
 * plane, ADR-0022 §2/§9). This is the composition seam through which a DERIVED
 * application contributes REVIEWED provisioning steps to a plan WITHOUT editing
 * the base orchestration (AC: "Derived applications can contribute reviewed
 * steps without editing base orchestration"). A derived module registers a
 * `ProvisioningStepHandler` via `registerProvisioningStep(...)`
 * (`tenant-provisioning/infrastructure/step-handler-registry.ts`) from its own
 * composition root — the same static, reviewed-source registration inversion
 * `domain_event_runtime`'s consumer registry uses (no runtime discovery,
 * upload, or `eval`; doc 21 §7 / ADR-0012 §7).
 *
 * A handler is a PURE-ish unit: given a tenant-scoped `tx` and the run's
 * minimized inputs, it performs its step and returns a classified outcome. It
 * NEVER receives or persists a provider secret/password/token — step I/O is
 * minimized and redacted (ADR-0022 §3/§6/§8). A step whose handler is not
 * registered, or whose optional provider is absent/disabled, is handled
 * FAIL-CLOSED by the engine (blocked or skipped) — a LAN/offline deployment
 * with every provider step absent still provisions (AC).
 *
 * The port lives on neutral ground (`_shared/ports`, imports NOTHING from any
 * module) so a contributing module imports only these TYPES.
 */

/** How a step relates to the source transaction / provider boundary. */
export type ProvisioningStepKind = "core" | "provider" | "derived";

/** Compensation safety classification (ADR-0022 §9) — fixed by the plan, drives cancellation/compensation. */
export type ProvisioningCompensationClass =
  "reversible" | "manual" | "forbidden";

/** A single step's declaration in a versioned provisioning plan. */
export type ProvisioningStepDefinition = {
  stepKey: string;
  kind: ProvisioningStepKind;
  compensationClass: ProvisioningCompensationClass;
  /** An optional step is SKIPPED (not failed) when not applicable — e.g. no subdomain requested, or its provider is disabled (LAN/offline safe). */
  optional: boolean;
  maxAttempts?: number;
  description: string;
};

/** The minimized, redacted inputs a run carries — NEVER a secret/password/token; provider secrets are references only. */
export type ProvisioningInputs = {
  tenantCode: string;
  tenantName: string;
  /** Arbitrary, bounded, redacted key/value options declared by the plan (e.g. locale, subdomain, presetKey). Never a credential. */
  options: Readonly<Record<string, unknown>>;
};

/** A prior step's recorded result reference (for cross-step dependencies). */
export type ProvisioningPriorResult = {
  stepKey: string;
  resultKind: string;
  resourceType: string | null;
  resourceId: string | null;
  output: Readonly<Record<string, unknown>>;
};

export type ProvisioningStepContext = {
  /** The caller's tenant-scoped transaction (RLS = the target tenant). */
  tx: Bun.SQL;
  /** The tenant being provisioned. */
  tenantId: string;
  /** The operator running the command (audit/provenance). */
  actorTenantUserId: string | null;
  /** The minimized, redacted run inputs. */
  inputs: ProvisioningInputs;
  /** Look up a prior completed step's result (dependency access). */
  getResult(stepKey: string): ProvisioningPriorResult | null;
  correlationId?: string;
};

/** Successful/terminal outcomes of executing a step. */
export type ProvisioningStepExecution =
  | {
      outcome: "completed";
      /** A short machine key describing what was produced (e.g. `owner_created`). Format `^[a-z][a-z0-9_]*$`. */
      resultKind: string;
      resourceType?: string;
      resourceId?: string;
      /** Minimized, redacted output — never a secret. Persisted on the result + checkpoint. */
      output?: Record<string, unknown>;
    }
  | {
      /** The step dispatched external/provider work OUTSIDE this transaction (via outbox/event) and awaits a later resume. */
      outcome: "waiting";
      note?: string;
      output?: Record<string, unknown>;
    }
  | {
      /** The optional step is not applicable (e.g. provider disabled / no subdomain) — skipped, not failed. */
      outcome: "skipped";
      reason: string;
    }
  | {
      outcome: "failed";
      errorClass:
        | "transient"
        | "permanent"
        | "provider_unavailable"
        | "validation"
        | "conflict"
        | "dependency_missing"
        | "timeout";
      message: string;
    };

export type ProvisioningStepCompensation =
  | { outcome: "completed"; note?: string }
  | { outcome: "manual_required"; note: string }
  | { outcome: "failed"; message: string };

export type ProvisioningStepHandler = {
  stepKey: string;
  /** Execute the step. MUST be idempotent: a resume may call it again after a checkpoint miss — re-running with the same inputs must not create duplicates. */
  execute(ctx: ProvisioningStepContext): Promise<ProvisioningStepExecution>;
  /**
   * Undo the step's effect (only meaningful for `reversible` steps). `manual`
   * steps return `manual_required`; `forbidden` steps have no compensate and
   * are never called. Compensation NEVER deletes tenant data (ADR-0022 §6/§9).
   */
  compensate?(
    ctx: ProvisioningStepContext
  ): Promise<ProvisioningStepCompensation>;
};
