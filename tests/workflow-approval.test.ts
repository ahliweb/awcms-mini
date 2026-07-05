import { describe, expect, test } from "bun:test";

import {
  evaluateDecisionOutcome,
  validateWorkflowDecisionRequestBody,
  validateWorkflowSteps
} from "../src/modules/workflow-approval/domain/workflow-transition";
import { computeRequestHash } from "../src/modules/_shared/idempotency";

describe("evaluateDecisionOutcome", () => {
  test("reject at step 1 of 1 ends the instance as rejected", () => {
    expect(
      evaluateDecisionOutcome({
        decision: "reject",
        currentStepOrder: 1,
        totalSteps: 1
      })
    ).toEqual({ instanceStatus: "rejected", nextStepOrder: null });
  });

  test("reject mid-sequence still ends the instance as rejected immediately", () => {
    expect(
      evaluateDecisionOutcome({
        decision: "reject",
        currentStepOrder: 1,
        totalSteps: 3
      })
    ).toEqual({ instanceStatus: "rejected", nextStepOrder: null });
  });

  test("approve mid-sequence advances to the next step and stays pending", () => {
    expect(
      evaluateDecisionOutcome({
        decision: "approve",
        currentStepOrder: 1,
        totalSteps: 2
      })
    ).toEqual({ instanceStatus: "pending", nextStepOrder: 2 });
  });

  test("approve at the last step approves the instance with no next step", () => {
    expect(
      evaluateDecisionOutcome({
        decision: "approve",
        currentStepOrder: 2,
        totalSteps: 2
      })
    ).toEqual({ instanceStatus: "approved", nextStepOrder: null });
  });

  test("approve on a single-step workflow approves immediately", () => {
    expect(
      evaluateDecisionOutcome({
        decision: "approve",
        currentStepOrder: 1,
        totalSteps: 1
      })
    ).toEqual({ instanceStatus: "approved", nextStepOrder: null });
  });
});

describe("validateWorkflowSteps", () => {
  test("accepts a valid contiguous steps array", () => {
    const result = validateWorkflowSteps([
      { stepOrder: 1, name: "Manager approval" },
      { stepOrder: 2, name: "Director approval" }
    ]);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual([
        { stepOrder: 1, name: "Manager approval" },
        { stepOrder: 2, name: "Director approval" }
      ]);
    }
  });

  test("rejects an empty array", () => {
    const result = validateWorkflowSteps([]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]?.field).toBe("steps");
    }
  });

  test("rejects a non-array value", () => {
    const result = validateWorkflowSteps("not-an-array");

    expect(result.valid).toBe(false);
  });

  test("rejects non-contiguous stepOrder values", () => {
    const result = validateWorkflowSteps([
      { stepOrder: 1, name: "Manager approval" },
      { stepOrder: 3, name: "Director approval" }
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]?.message).toContain("contiguous");
    }
  });

  test("rejects a step missing name", () => {
    const result = validateWorkflowSteps([{ stepOrder: 1 }]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((error) => error.field === "steps[0].name")
      ).toBe(true);
    }
  });

  test("rejects a step with a non-positive stepOrder", () => {
    const result = validateWorkflowSteps([{ stepOrder: 0, name: "Bad" }]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((error) => error.field === "steps[0].stepOrder")
      ).toBe(true);
    }
  });
});

describe("validateWorkflowDecisionRequestBody", () => {
  test("accepts a valid approve decision", () => {
    const result = validateWorkflowDecisionRequestBody({
      decision: "approve"
    });

    expect(result.valid).toBe(true);
  });

  test("accepts a valid reject decision with a reason", () => {
    const result = validateWorkflowDecisionRequestBody({
      decision: "reject",
      reason: "Budget exceeded"
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.reason).toBe("Budget exceeded");
    }
  });

  test("rejects an invalid decision value", () => {
    const result = validateWorkflowDecisionRequestBody({
      decision: "maybe"
    });

    expect(result.valid).toBe(false);
  });

  test("rejects a non-string reason", () => {
    const result = validateWorkflowDecisionRequestBody({
      decision: "approve",
      reason: 123
    });

    expect(result.valid).toBe(false);
  });
});

describe("computeRequestHash", () => {
  test("is stable regardless of key order", () => {
    const a = computeRequestHash({ decision: "approve", taskId: "t1" });
    const b = computeRequestHash({ taskId: "t1", decision: "approve" });

    expect(a).toBe(b);
  });

  test("differs when the payload differs", () => {
    const a = computeRequestHash({ decision: "approve", taskId: "t1" });
    const b = computeRequestHash({ decision: "reject", taskId: "t1" });

    expect(a).not.toBe(b);
  });
});
