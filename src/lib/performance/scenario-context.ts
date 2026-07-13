/**
 * Shared mutable scenario state (Issue #744, epic #738 platform-evolution).
 *
 * Every performance scenario in `scenarios/*.ts` implements the SAME
 * `ScenarioDefinition` shape resilience drills already use
 * (`src/lib/resilience/scenario-runner.ts` — `ScenarioDefinition`,
 * `runScenario`, `computeDrOverall` are imported and reused UNCHANGED by
 * `scripts/performance-suite.ts`, not reimplemented). That type's `run(ctx:
 * ScenarioContext)` only carries `{ databaseUrl, env }` — enough for
 * resilience's own scenarios, which each open what they need themselves,
 * but a performance scenario additionally needs the SAME already-open
 * `Bun.SQL` client and fixture plan every other scenario in the same run
 * uses (opening a fresh pool per scenario would be wasteful and would not
 * reuse the exact tenant ids the fixtures were seeded under). This module
 * is the one place that state lives — set once by
 * `scripts/performance-suite.ts` before any scenario runs, read by every
 * scenario via the getters below, mirroring the same "small, mutable,
 * module-level state" pattern `src/lib/database/work-class.ts` already
 * uses for its own gate state.
 */
import type { FixturePlan } from "./fixture-generator";
import type { PerformanceScaleProfile } from "./scale-profiles";

type PerformanceScenarioState = {
  sql: Bun.SQL;
  plan: FixturePlan;
  scaleProfile: PerformanceScaleProfile;
};

let state: PerformanceScenarioState | null = null;

export function setPerformanceScenarioState(
  next: PerformanceScenarioState
): void {
  state = next;
}

export function resetPerformanceScenarioStateForTests(): void {
  state = null;
}

function requireState(): PerformanceScenarioState {
  if (!state) {
    throw new Error(
      "Performance scenario state not initialized — " +
        "setPerformanceScenarioState() must run before any scenario."
    );
  }

  return state;
}

export function getPerformanceSql(): Bun.SQL {
  return requireState().sql;
}

export function getPerformanceFixturePlan(): FixturePlan {
  return requireState().plan;
}

export function getPerformanceScaleProfile(): PerformanceScaleProfile {
  return requireState().scaleProfile;
}

/** A deterministic, non-noisy-neighbor tenant — the first tenant in the plan. */
export function primaryTenantId(): string {
  return requireState().plan.tenants[0]!.tenantId;
}

/** The designated noisy-neighbor tenant — always the LAST tenant in the plan (see `fixture-generator.ts`). */
export function noisyNeighborTenantId(): string {
  const { tenants } = requireState().plan;
  return tenants[tenants.length - 1]!.tenantId;
}

/** All tenant ids in the plan — for scenarios that spread load across the whole roster. */
export function allTenantIds(): string[] {
  return requireState().plan.tenants.map((tenant) => tenant.tenantId);
}
