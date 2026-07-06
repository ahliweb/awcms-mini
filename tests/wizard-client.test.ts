import { describe, expect, test } from "bun:test";

import {
  advanceWizard,
  canGoBack,
  canGoForward,
  createWizardIdempotencyKey,
  createWizardState,
  getActiveWizardStep,
  getFieldErrors,
  getWizardProgress,
  hasFieldError,
  jumpToWizardStep,
  mapValidationDetailsToFieldErrors,
  rewindWizard,
  toFieldErrorMap,
  type WizardFieldError,
  type WizardStepDefinition
} from "../src/lib/ui/wizard-client";

const steps: WizardStepDefinition[] = [
  {
    key: "basic",
    title: "Basic",
    fields: ["title"]
  },
  {
    key: "participants",
    title: "Participants",
    fields: ["participants"]
  },
  {
    key: "review",
    title: "Review",
    fields: []
  }
];

describe("wizard client helper", () => {
  test("creates a valid initial state", () => {
    const state = createWizardState(steps);

    expect(getActiveWizardStep(state).key).toBe("basic");
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(true);
    expect(getWizardProgress(state)).toEqual({
      current: 1,
      total: 3,
      percent: 33,
      activeStep: steps[0]!
    });
  });

  test("rejects empty and duplicate step definitions", () => {
    expect(() => createWizardState([])).toThrow(
      "Wizard must define at least one step."
    );

    expect(() =>
      createWizardState([
        { key: "basic", title: "Basic", fields: [] },
        { key: "basic", title: "Duplicate", fields: [] }
      ])
    ).toThrow("Duplicate wizard step key: basic");
  });

  test("blocks advancement and records field errors when current step is invalid", () => {
    const state = createWizardState(steps);
    const result = advanceWizard(state, {}, (step): WizardFieldError[] => {
      if (step.key !== "basic") return [];
      return [{ field: "title", message: "Title is required." }];
    });

    expect(result.advanced).toBe(false);
    expect(getActiveWizardStep(result.state).key).toBe("basic");
    expect(hasFieldError(result.state, "title")).toBe(true);
    expect(getFieldErrors(result.state, "title")).toEqual([
      "Title is required."
    ]);
  });

  test("advances and marks current step completed when valid", () => {
    const state = createWizardState(steps);
    const result = advanceWizard(state, { title: "Demo" }, () => []);

    expect(result.advanced).toBe(true);
    expect(getActiveWizardStep(result.state).key).toBe("participants");
    expect(result.state.completedStepKeys).toEqual(["basic"]);
    expect(result.state.fieldErrors).toEqual({});
  });

  test("rewinds without dropping completed step state", () => {
    const first = advanceWizard(createWizardState(steps), {}, () => []);

    expect(first.advanced).toBe(true);

    const rewound = rewindWizard(first.state);

    expect(getActiveWizardStep(rewound).key).toBe("basic");
    expect(rewound.completedStepKeys).toEqual(["basic"]);
  });

  test("does not jump over unfinished steps", () => {
    const state = createWizardState(steps);
    const jumped = jumpToWizardStep(state, "review");

    expect(getActiveWizardStep(jumped).key).toBe("basic");
  });

  test("allows jumping to the immediate next step", () => {
    const state = createWizardState(steps);
    const jumped = jumpToWizardStep(state, "participants");

    expect(getActiveWizardStep(jumped).key).toBe("participants");
  });

  test("maps field errors and server validation details", () => {
    expect(
      toFieldErrorMap([
        { field: "title", message: "Title is required." },
        { field: "title", message: "Title is too short." },
        { field: "", message: "Ignored." }
      ])
    ).toEqual({
      title: ["Title is required.", "Title is too short."]
    });

    expect(
      mapValidationDetailsToFieldErrors([
        { field: "title", message: "Title is required." },
        { field: "ignored", message: "" },
        { message: "Missing field." },
        null
      ])
    ).toEqual([{ field: "title", message: "Title is required." }]);
  });

  test("creates a namespaced idempotency key for final submit", () => {
    const key = createWizardIdempotencyKey("duty-travel");

    expect(key.startsWith("duty-travel:")).toBe(true);
    expect(key.split(":")[1]).toBeTruthy();
  });
});
