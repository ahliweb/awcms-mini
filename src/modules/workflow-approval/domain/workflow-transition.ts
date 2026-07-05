/**
 * Pure workflow transition logic (Issue 11.1). No I/O — callers (the
 * decision API route / `startWorkflowInstance`) own persistence.
 */

export type WorkflowDecision = "approve" | "reject";

export type DecisionOutcomeInput = {
  decision: WorkflowDecision;
  currentStepOrder: number;
  totalSteps: number;
};

export type WorkflowInstanceStatus = "approved" | "rejected" | "pending";

export type DecisionOutcome = {
  instanceStatus: WorkflowInstanceStatus;
  nextStepOrder: number | null;
};

/**
 * `"reject"` at any step ends the instance immediately (`rejected`, no
 * further task). `"approve"` advances to the next step unless the current
 * step is already the last one, in which case the instance is `approved`.
 */
export function evaluateDecisionOutcome(
  input: DecisionOutcomeInput
): DecisionOutcome {
  if (input.decision === "reject") {
    return { instanceStatus: "rejected", nextStepOrder: null };
  }

  if (input.currentStepOrder < input.totalSteps) {
    return {
      instanceStatus: "pending",
      nextStepOrder: input.currentStepOrder + 1
    };
  }

  return { instanceStatus: "approved", nextStepOrder: null };
}

export type WorkflowStepDefinition = {
  stepOrder: number;
  name: string;
};

export type ValidationError = {
  field: string;
  message: string;
};

export type WorkflowDecisionRequestBody = {
  decision: WorkflowDecision;
  reason?: string;
};

export type WorkflowDecisionRequestValidationResult =
  | { valid: true; value: WorkflowDecisionRequestBody }
  | { valid: false; errors: ValidationError[] };

/**
 * Validates `POST /workflows/tasks/{id}/decisions` request bodies.
 * `decision` must be `"approve"` or `"reject"`; `reason` is an optional
 * string.
 */
export function validateWorkflowDecisionRequestBody(
  body: unknown
): WorkflowDecisionRequestValidationResult {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;
  const decision = record.decision;

  if (decision !== "approve" && decision !== "reject") {
    errors.push({
      field: "decision",
      message: 'decision must be "approve" or "reject".'
    });
  }

  if (record.reason !== undefined && typeof record.reason !== "string") {
    errors.push({ field: "reason", message: "reason must be a string." });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      decision: decision as WorkflowDecision,
      reason: typeof record.reason === "string" ? record.reason : undefined
    }
  };
}

export type WorkflowStepsValidationResult =
  | { valid: true; value: WorkflowStepDefinition[] }
  | { valid: false; errors: ValidationError[] };

/**
 * Validates the `steps` jsonb shape used by `awcms_mini_workflow_definitions`
 * (doc 04 §Workflow). Used only by the internal instance-starting path
 * (`startWorkflowInstance`) — there is no public HTTP endpoint that accepts
 * raw `steps` input in this base (doc 17's seed model grants no
 * create/configure action for `workflow.approval`).
 */
export function validateWorkflowSteps(
  input: unknown
): WorkflowStepsValidationResult {
  const errors: ValidationError[] = [];

  if (!Array.isArray(input) || input.length === 0) {
    return {
      valid: false,
      errors: [{ field: "steps", message: "steps must be a non-empty array." }]
    };
  }

  const steps: WorkflowStepDefinition[] = [];

  input.forEach((entry, index) => {
    const candidate = (entry ?? {}) as Record<string, unknown>;
    const stepOrder = candidate.stepOrder;
    const name = candidate.name;

    if (
      typeof stepOrder !== "number" ||
      !Number.isInteger(stepOrder) ||
      stepOrder <= 0
    ) {
      errors.push({
        field: `steps[${index}].stepOrder`,
        message: "stepOrder must be a positive integer."
      });
    }

    if (typeof name !== "string" || name.trim().length === 0) {
      errors.push({
        field: `steps[${index}].name`,
        message: "name is required."
      });
    }

    steps.push({
      stepOrder: typeof stepOrder === "number" ? stepOrder : Number.NaN,
      name: typeof name === "string" ? name : ""
    });
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const orderedStepOrders = steps
    .map((step) => step.stepOrder)
    .sort((left, right) => left - right);
  const isContiguousFromOne = orderedStepOrders.every(
    (stepOrder, index) => stepOrder === index + 1
  );

  if (!isContiguousFromOne) {
    return {
      valid: false,
      errors: [
        {
          field: "steps",
          message: "stepOrder values must be contiguous starting at 1."
        }
      ]
    };
  }

  return { valid: true, value: steps };
}
