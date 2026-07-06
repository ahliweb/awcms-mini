import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Accessibility regression guard for the reusable wizard components (Issue
 * #485). These are static Astro components with no client-side reactivity
 * of their own (Issue #479/#480) — there is no jsdom/component-rendering
 * harness in this repo to mount them, so this asserts directly on the
 * source markup/CSS instead. That's a deliberate, narrow scope: this
 * guards against someone *silently removing* an accessibility attribute
 * during a future edit (same spirit as `theme-init-script.test.ts`'s
 * hash-drift guard), not a substitute for real assistive-tech testing.
 *
 * See `docs/awcms-mini/examples/wizard-form-pattern.md` §Accessibility
 * checklist for the full checklist this test covers, and
 * `src/pages/admin/examples/wizard.astro` (Issue #483) for a manual
 * keyboard-only walkthrough script.
 */

const COMPONENTS_DIR = path.resolve(
  import.meta.dirname,
  "../src/components/ui"
);

function readComponent(name: string): string {
  return readFileSync(path.join(COMPONENTS_DIR, name), "utf8");
}

describe("WizardStepper accessibility", () => {
  const source = readComponent("WizardStepper.astro");

  test("marks the active step with aria-current=step", () => {
    expect(source).toContain('aria-current={isActive ? "step" : undefined}');
  });

  test("accepts a translatable label prop for the nav landmark (not hardcoded, per i18n policy)", () => {
    expect(source).toMatch(/label\?:\s*string/);
    expect(source).toContain("aria-label={label}");
  });

  test("status is conveyed via text, not color alone", () => {
    // stateLabel (Current/Completed/Pending, all translatable props) is
    // rendered as visible text alongside the marker — color is additive,
    // not the sole signal.
    expect(source).toContain(
      '<span class="wizard-stepper-status">{stateLabel}</span>'
    );
    expect(source).toMatch(/currentLabel\?:\s*string/);
    expect(source).toMatch(/completedLabel\?:\s*string/);
    expect(source).toMatch(/pendingLabel\?:\s*string/);
  });

  test("exposes a per-item selector so client scripts can update state after initial render", () => {
    // Issue #483 found this was missing entirely; without it, no calling
    // page can keep the stepper in sync after a Next/Back transition.
    expect(source).toContain("data-step-key={step.key}");
  });
});

describe("WizardPanel accessibility", () => {
  const source = readComponent("WizardPanel.astro");

  test("error summary uses role=alert so assistive tech announces it", () => {
    expect(source).toContain('<div class="wizard-panel-errors" role="alert">');
  });

  test("error summary heading is an overridable prop, not hardcoded (i18n policy)", () => {
    expect(source).toMatch(/errorSummaryHeading\?:\s*string/);
  });

  test("panel is labelled by its own heading for screen readers", () => {
    expect(source).toContain("aria-labelledby={`${id}-title`}");
  });
});

describe("WizardActions accessibility", () => {
  const source = readComponent("WizardActions.astro");

  test("busy/submitting state is exposed via aria-busy and disables buttons", () => {
    expect(source).toContain('aria-busy={busy ? "true" : "false"}');
    expect(source.match(/disabled={busy}/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("buttons meet the 44px minimum touch target", () => {
    expect(source).toMatch(/min-height:\s*44px/);
  });

  test("buttons have a visible focus indicator", () => {
    expect(source).toContain(".wizard-action:focus-visible");
  });

  test("secondary actions (Back) render before primary actions (Next/Submit) in source order, matching logical Back-then-forward tab order", () => {
    const backIndex = source.indexOf("wizard-actions-secondary");
    const primaryIndex = source.indexOf("wizard-actions-primary");
    expect(backIndex).toBeGreaterThan(-1);
    expect(primaryIndex).toBeGreaterThan(backIndex);
  });
});
