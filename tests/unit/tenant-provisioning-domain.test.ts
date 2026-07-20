/**
 * Unit tests for `tenant_provisioning` pure domain logic (Issue #872, epic
 * #868, ADR-0022): state-machine transitions, plan/step registry validation,
 * compensation classification, error classification + bounded retry, and the
 * fail-closed request parser. No database.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  isCancelableStatus,
  isLegalRequestTransition,
  isLegalStepTransition,
  isResumableStatus,
  isTerminalRequestStatus,
  type RequestStatus,
  type StepStatus
} from "../../src/modules/tenant-provisioning/domain/provisioning-state";
import {
  CORE_STEP_KEYS,
  getLatestProvisioningPlan,
  getProvisioningPlan,
  listProvisioningPlans,
  registerProvisioningPlan,
  resetContributedProvisioningPlans,
  STANDARD_TENANT_V1,
  type ProvisioningPlan
} from "../../src/modules/tenant-provisioning/domain/provisioning-plan";
import {
  compensationActionFor,
  resolveCompensationOutcome
} from "../../src/modules/tenant-provisioning/domain/compensation";
import {
  classifyThrownError,
  isProvisioningErrorClass,
  isRetryableErrorClass,
  shouldRetry
} from "../../src/modules/tenant-provisioning/domain/error-classification";
import { parseProvisioningRequestBody } from "../../src/modules/tenant-provisioning/application/request-parsing";
import { validateProvisioningRequest } from "../../src/modules/tenant-provisioning/domain/request-validation";

describe("provisioning state machine", () => {
  test("legal request transitions (ADR-0022 §11.1)", () => {
    const legal: [RequestStatus, RequestStatus][] = [
      ["requested", "in_progress"],
      ["requested", "canceled"],
      ["in_progress", "provisioned"],
      ["in_progress", "compensating"],
      ["in_progress", "blocked"],
      ["compensating", "failed"],
      ["compensating", "blocked"],
      ["failed", "in_progress"],
      ["blocked", "in_progress"],
      ["provisioned", "reconciling"],
      ["reconciling", "provisioned"]
    ];
    for (const [from, to] of legal) {
      expect(isLegalRequestTransition(from, to), `${from}->${to}`).toBe(true);
    }
    // same-status no-op is always allowed (counter/checkpoint writes)
    expect(isLegalRequestTransition("in_progress", "in_progress")).toBe(true);
  });

  test("illegal request transitions are rejected", () => {
    const illegal: [RequestStatus, RequestStatus][] = [
      ["canceled", "in_progress"], // terminal
      ["provisioned", "in_progress"], // only reconciling
      ["requested", "provisioned"], // must go in_progress first
      ["failed", "provisioned"],
      ["blocked", "provisioned"]
    ];
    for (const [from, to] of illegal) {
      expect(isLegalRequestTransition(from, to), `${from}->${to}`).toBe(false);
    }
  });

  test("legal + illegal step transitions", () => {
    const legal: [StepStatus, StepStatus][] = [
      ["pending", "running"],
      ["pending", "skipped"],
      ["running", "completed"],
      ["running", "failed"],
      ["running", "waiting"],
      ["waiting", "completed"],
      ["failed", "running"],
      ["failed", "compensation_pending"],
      ["completed", "compensation_pending"],
      ["compensation_pending", "compensated"]
    ];
    for (const [from, to] of legal) {
      expect(isLegalStepTransition(from, to), `${from}->${to}`).toBe(true);
    }
    // A completed step never silently reopens to running/pending.
    expect(isLegalStepTransition("completed", "running")).toBe(false);
    expect(isLegalStepTransition("skipped", "running")).toBe(false);
    expect(isLegalStepTransition("compensated", "running")).toBe(false);
  });

  test("resumable / cancelable / terminal predicates", () => {
    expect(isResumableStatus("requested")).toBe(true);
    expect(isResumableStatus("failed")).toBe(true);
    expect(isResumableStatus("blocked")).toBe(true);
    expect(isResumableStatus("provisioned")).toBe(false);
    expect(isResumableStatus("canceled")).toBe(false);
    expect(isCancelableStatus("in_progress")).toBe(true);
    expect(isCancelableStatus("provisioned")).toBe(false);
    expect(isCancelableStatus("canceled")).toBe(false);
    expect(isTerminalRequestStatus("canceled")).toBe(true);
    expect(isTerminalRequestStatus("provisioned")).toBe(false);
  });
});

describe("provisioning plan registry", () => {
  afterEach(() => resetContributedProvisioningPlans());

  test("base standard_tenant v1 has the seven ordered core steps", () => {
    expect(STANDARD_TENANT_V1.steps.length).toBe(7);
    expect(STANDARD_TENANT_V1.steps.map((s) => s.stepKey)).toEqual([
      CORE_STEP_KEYS.tenantBootstrap,
      CORE_STEP_KEYS.ownerIdentity,
      CORE_STEP_KEYS.defaultConfiguration,
      CORE_STEP_KEYS.entitlementAssignment,
      CORE_STEP_KEYS.modulePreset,
      CORE_STEP_KEYS.subdomainRequest,
      CORE_STEP_KEYS.readinessCheck
    ]);
    // tenant_bootstrap + readiness are forbidden (never reversed); owner is manual.
    const byKey = new Map(STANDARD_TENANT_V1.steps.map((s) => [s.stepKey, s]));
    expect(byKey.get(CORE_STEP_KEYS.tenantBootstrap)!.compensationClass).toBe(
      "forbidden"
    );
    expect(byKey.get(CORE_STEP_KEYS.readinessCheck)!.compensationClass).toBe(
      "forbidden"
    );
    expect(byKey.get(CORE_STEP_KEYS.ownerIdentity)!.compensationClass).toBe(
      "manual"
    );
    // entitlement/module/subdomain are optional (skip when not applicable).
    expect(byKey.get(CORE_STEP_KEYS.entitlementAssignment)!.optional).toBe(
      true
    );
    expect(byKey.get(CORE_STEP_KEYS.subdomainRequest)!.optional).toBe(true);
  });

  test("getProvisioningPlan resolves known, rejects unknown (fail-closed)", () => {
    expect(getProvisioningPlan("standard_tenant", 1)).not.toBeNull();
    expect(getProvisioningPlan("standard_tenant", 99)).toBeNull();
    expect(getProvisioningPlan("nope", 1)).toBeNull();
  });

  test("registerProvisioningPlan adds a derived plan; cannot override base; immutable version", () => {
    const derived: ProvisioningPlan = {
      planKey: "derived_plan",
      version: 1,
      description: "derived",
      steps: [
        {
          stepKey: "derived_step",
          kind: "derived",
          compensationClass: "reversible",
          optional: false,
          description: "d"
        }
      ]
    };
    registerProvisioningPlan(derived);
    expect(getProvisioningPlan("derived_plan", 1)).not.toBeNull();
    expect(getLatestProvisioningPlan("derived_plan")!.version).toBe(1);
    // re-register identical is fine
    registerProvisioningPlan(derived);
    // different shape same key/version rejected
    expect(() =>
      registerProvisioningPlan({ ...derived, description: "changed" })
    ).toThrow();
    // cannot override a base plan
    expect(() =>
      registerProvisioningPlan({ ...STANDARD_TENANT_V1, description: "x" })
    ).toThrow();
    expect(
      listProvisioningPlans().some((p) => p.planKey === "derived_plan")
    ).toBe(true);
  });

  test("plan validation rejects duplicate step keys + empty steps", () => {
    expect(() =>
      registerProvisioningPlan({
        planKey: "dupe",
        version: 1,
        description: "x",
        steps: [
          {
            stepKey: "a",
            kind: "core",
            compensationClass: "reversible",
            optional: false,
            description: ""
          },
          {
            stepKey: "a",
            kind: "core",
            compensationClass: "reversible",
            optional: false,
            description: ""
          }
        ]
      })
    ).toThrow();
    expect(() =>
      registerProvisioningPlan({
        planKey: "empty",
        version: 1,
        description: "x",
        steps: []
      })
    ).toThrow();
  });

  test("readiness_check must be the TERMINAL step (review L-3)", () => {
    // A plan placing a step AFTER readiness is rejected (activation must be
    // terminal — a later failing step could otherwise leave a tenant active).
    expect(() =>
      registerProvisioningPlan({
        planKey: "readiness_not_last",
        version: 1,
        description: "x",
        steps: [
          {
            stepKey: CORE_STEP_KEYS.readinessCheck,
            kind: "core",
            compensationClass: "forbidden",
            optional: false,
            description: ""
          },
          {
            stepKey: "after",
            kind: "core",
            compensationClass: "reversible",
            optional: false,
            description: ""
          }
        ]
      })
    ).toThrow();
    // readiness as the last step is accepted.
    expect(() =>
      registerProvisioningPlan({
        planKey: "readiness_last",
        version: 1,
        description: "x",
        steps: [
          {
            stepKey: "first",
            kind: "core",
            compensationClass: "reversible",
            optional: false,
            description: ""
          },
          {
            stepKey: CORE_STEP_KEYS.readinessCheck,
            kind: "core",
            compensationClass: "forbidden",
            optional: false,
            description: ""
          }
        ]
      })
    ).not.toThrow();
    // The base plan itself already satisfies this.
    expect(
      STANDARD_TENANT_V1.steps[STANDARD_TENANT_V1.steps.length - 1]!.stepKey
    ).toBe(CORE_STEP_KEYS.readinessCheck);
  });
});

describe("compensation classification (ADR-0022 §9)", () => {
  test("action per class", () => {
    expect(compensationActionFor("reversible")).toBe("run_compensation");
    expect(compensationActionFor("manual")).toBe("mark_manual");
    expect(compensationActionFor("forbidden")).toBe("skip_forbidden");
  });

  test("outcome: manual/failed => blocked; clean => failed", () => {
    expect(
      resolveCompensationOutcome({
        anyManualRequired: false,
        anyCompensationFailed: false
      })
    ).toBe("failed");
    expect(
      resolveCompensationOutcome({
        anyManualRequired: true,
        anyCompensationFailed: false
      })
    ).toBe("blocked");
    expect(
      resolveCompensationOutcome({
        anyManualRequired: false,
        anyCompensationFailed: true
      })
    ).toBe("blocked");
  });
});

describe("error classification + bounded retry", () => {
  test("retryable classes", () => {
    expect(isRetryableErrorClass("transient")).toBe(true);
    expect(isRetryableErrorClass("provider_unavailable")).toBe(true);
    expect(isRetryableErrorClass("timeout")).toBe(true);
    expect(isRetryableErrorClass("permanent")).toBe(false);
    expect(isRetryableErrorClass("validation")).toBe(false);
    expect(isRetryableErrorClass("conflict")).toBe(false);
  });

  test("shouldRetry is bounded by maxAttempts", () => {
    expect(shouldRetry("transient", 1, 3)).toBe(true);
    expect(shouldRetry("transient", 3, 3)).toBe(false); // budget exhausted
    expect(shouldRetry("permanent", 1, 3)).toBe(false); // non-retryable
    expect(shouldRetry("validation", 1, 5)).toBe(false);
  });

  test("classifyThrownError => transient + safe (no stack/secret)", () => {
    const c = classifyThrownError(new Error("boom secret token=abc"));
    expect(c.errorClass).toBe("transient");
    expect(c.message).toBe("step_error:Error");
    expect(c.message).not.toContain("secret");
    expect(isProvisioningErrorClass("transient")).toBe(true);
    expect(isProvisioningErrorClass("nope")).toBe(false);
  });
});

describe("request parser is fail-closed (epic pattern #6)", () => {
  test("absent scalars/number => neutral defaults (NaN for required number)", () => {
    const parsed = parseProvisioningRequestBody({});
    expect(parsed.planKey).toBe("");
    expect(Number.isNaN(parsed.planVersion)).toBe(true);
    expect(parsed.legalName).toBeNull();
    expect(parsed.owner.password).toBe("");
    expect(parsed.options.subdomain).toBeNull();
    expect(parsed.options.offerVersion).toBeNull();
  });

  test("present-but-wrong-type is kept verbatim so the validator rejects it (never coerced)", () => {
    const parsed = parseProvisioningRequestBody({
      planVersion: "1", // wrong type kept -> NaN via asNumberVerbatim
      legalName: 123, // wrong type kept for validator
      options: { subdomain: 42, offerVersion: "3" }
    });
    expect(Number.isNaN(parsed.planVersion)).toBe(true);
    expect(parsed.legalName).toBe(123 as unknown as string);
    expect(parsed.options.subdomain).toBe(42 as unknown as string);
    expect(parsed.options.offerVersion).toBe("3" as unknown as number);
  });

  test("non-object owner/options => {} (validator's required checks fail, no partial default)", () => {
    const parsed = parseProvisioningRequestBody({
      owner: "nope",
      options: [1, 2]
    });
    expect(parsed.owner.displayName).toBe("");
    expect(parsed.owner.password).toBe("");
    expect(parsed.options.defaultLocale).toBeNull();
  });
});

describe("request validation", () => {
  function validInput() {
    return {
      planKey: "standard_tenant",
      planVersion: 1,
      tenantCode: "acme-01",
      tenantName: "Acme",
      legalName: null,
      owner: {
        displayName: "Owner",
        loginIdentifier: "owner@acme.test",
        password: "supersecret"
      },
      officeCode: "ho",
      officeName: "Head Office",
      options: {
        defaultLocale: null,
        defaultTheme: null,
        timezone: null,
        subdomain: null,
        presetKey: null,
        offerPlanKey: null,
        offerVersion: null
      }
    };
  }

  test("valid input passes", () => {
    expect(validateProvisioningRequest(validInput())).toEqual([]);
  });

  test("unknown plan, bad code, short password, offer both-or-neither are rejected", () => {
    const unknownPlan = validateProvisioningRequest({
      ...validInput(),
      planKey: "nope"
    });
    expect(unknownPlan.some((e) => e.field === "planKey")).toBe(true);

    const badCode = validateProvisioningRequest({
      ...validInput(),
      tenantCode: "BAD CODE"
    });
    expect(badCode.some((e) => e.field === "tenantCode")).toBe(true);

    const shortPw = validateProvisioningRequest({
      ...validInput(),
      owner: { ...validInput().owner, password: "short" }
    });
    expect(shortPw.some((e) => e.field === "owner.password")).toBe(true);

    const halfOffer = validateProvisioningRequest({
      ...validInput(),
      options: {
        ...validInput().options,
        offerPlanKey: "growth",
        offerVersion: null
      }
    });
    expect(halfOffer.some((e) => e.field === "options.offerPlanKey")).toBe(
      true
    );
  });
});
