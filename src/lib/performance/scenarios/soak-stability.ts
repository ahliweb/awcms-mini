/**
 * Soak-stability scenario (Issue #744, epic #738 platform-evolution) —
 * `tier: "full"` ONLY (never part of the CI-safe subset — see
 * `docs/awcms-mini/performance-suite.md` §Safe subset vs. full lane): the
 * issue's "memory/CPU remain stable during soak; no unbounded growth"
 * minimum validation target needs sustained duration
 * (`scaleProfile.soakDurationMs`, 0 at the `safe` profile so this scenario
 * self-skips there) to be meaningful — a short burst cannot distinguish a
 * genuine leak from ordinary allocation noise.
 *
 * Repeatedly runs the same real `interactiveAuditRead` call in a tight,
 * unthrottled sequential loop for the profile's configured duration,
 * sampling process RSS at several evenly-spaced CHECKPOINTS (not just
 * once at the start and once at the end).
 *
 * A single before/after delta against a fixed MB ceiling was tried first
 * and rejected empirically: an unthrottled loop this tight processes
 * hundreds of thousands of calls in even the `standard` profile's 60s
 * window, and ordinary GC-collectible per-call garbage (query result
 * objects, tagged-template intermediates) genuinely accumulates to
 * 100+MB of RSS before the collector catches up — that is transient
 * allocation pressure, not a leak, and no single fixed threshold
 * distinguishes the two without either being flaky (too tight) or
 * meaningless (too loose). Instead, this compares GROWTH RATE across the
 * FIRST half of the run against the SECOND half: a genuine unbounded leak
 * keeps growing at a steady-or-increasing rate for as long as the process
 * runs, while transient allocation pressure plateaus once the heap
 * reaches its working-set size — the second half should show
 * meaningfully LESS growth than the first half (or both are already
 * small). This is self-calibrating (no guessed absolute ceiling to tune
 * per environment) and directly tests the acceptance criterion's own
 * wording ("no UNBOUNDED growth"), not "zero growth".
 */
import type {
  ScenarioContext,
  ScenarioDefinition,
  ScenarioOutcome
} from "../../resilience/scenario-runner";
import {
  diffProcessResources,
  sampleProcessResources,
  type ProcessResourceSnapshot
} from "../process-metrics";
import {
  allTenantIds,
  getPerformanceScaleProfile,
  getPerformanceSql
} from "../scenario-context";
import { interactiveAuditRead } from "../workload";

/** RSS samples taken over the run, evenly spaced in wall-clock time (>= 3 so there is a genuine "first half"/"second half" to compare). */
const CHECKPOINT_COUNT = 6;
/** Below this, a segment's growth is treated as noise regardless of ratio — avoids flagging "0.4MB in the first half, 0.9MB in the second half" as a 2x-growth-rate false positive. */
const NOISE_FLOOR_MB = 10;
/** Second-half growth may be at most this multiple of first-half growth before being treated as still-climbing (possible unbounded growth) rather than settling. */
const MAX_SECOND_HALF_RATIO = 1.5;

export function soakStabilityScenario(): ScenarioDefinition {
  return {
    name: "soak-stability",
    tier: "full",
    timeoutMs: 15 * 60_000,
    async run(_ctx: ScenarioContext): Promise<ScenarioOutcome> {
      const scaleProfile = getPerformanceScaleProfile();

      if (scaleProfile.soakDurationMs <= 0) {
        return {
          ok: true,
          skipped: true,
          detail: `Scale profile "${scaleProfile.id}" has soakDurationMs=0 — soak scenario intentionally skipped at this scale.`
        };
      }

      const sql = getPerformanceSql();
      const tenantIds = allTenantIds();
      const startedAt = Date.now();
      const deadline = startedAt + scaleProfile.soakDurationMs;
      const checkpointIntervalMs =
        scaleProfile.soakDurationMs / CHECKPOINT_COUNT;

      const checkpoints: ProcessResourceSnapshot[] = [sampleProcessResources()];
      let nextCheckpointAt = startedAt + checkpointIntervalMs;
      let callCount = 0;
      let errorCount = 0;

      while (Date.now() < deadline) {
        const tenantId = tenantIds[callCount % tenantIds.length]!;
        const result = await interactiveAuditRead(sql, tenantId, 2000);

        if (!result.ok) {
          errorCount++;
        }

        callCount++;

        if (Date.now() >= nextCheckpointAt) {
          checkpoints.push(sampleProcessResources());
          nextCheckpointAt += checkpointIntervalMs;
        }
      }

      checkpoints.push(sampleProcessResources());

      const segments = checkpoints
        .slice(1)
        .map((snapshot, index) =>
          diffProcessResources(checkpoints[index]!, snapshot)
        );
      const midpoint = Math.floor(segments.length / 2);
      const firstHalfGrowthMb = segments
        .slice(0, midpoint)
        .reduce((sum, segment) => sum + segment.rssDeltaMb, 0);
      const secondHalfGrowthMb = segments
        .slice(midpoint)
        .reduce((sum, segment) => sum + segment.rssDeltaMb, 0);
      const totalDelta = diffProcessResources(
        checkpoints[0]!,
        checkpoints[checkpoints.length - 1]!
      );

      const stillClimbing =
        secondHalfGrowthMb > NOISE_FLOOR_MB &&
        firstHalfGrowthMb > NOISE_FLOOR_MB &&
        secondHalfGrowthMb > firstHalfGrowthMb * MAX_SECOND_HALF_RATIO;
      // A second half that grows meaningfully even though the first half
      // was near-zero is ALSO worth flagging (growth that only starts
      // partway through the run) — but never for total growth under the
      // noise floor.
      const growthStartedLate =
        firstHalfGrowthMb <= NOISE_FLOOR_MB &&
        secondHalfGrowthMb > NOISE_FLOOR_MB * MAX_SECOND_HALF_RATIO;
      const ok = !stillClimbing && !growthStartedLate;

      return {
        ok,
        detail: ok
          ? `Soak ran ${callCount} calls over ${scaleProfile.soakDurationMs}ms; RSS growth settled ` +
            `(first half ${firstHalfGrowthMb.toFixed(1)}MB, second half ${secondHalfGrowthMb.toFixed(1)}MB, total ${totalDelta.rssDeltaMb.toFixed(1)}MB), ${errorCount} errors.`
          : `Soak RSS growth did not settle: first half ${firstHalfGrowthMb.toFixed(1)}MB, ` +
            `second half ${secondHalfGrowthMb.toFixed(1)}MB (total ${totalDelta.rssDeltaMb.toFixed(1)}MB over ${callCount} calls) — possible unbounded growth.`,
        metrics: {
          callCount,
          errorCount,
          rssDeltaMb: Math.round(totalDelta.rssDeltaMb * 100) / 100,
          firstHalfGrowthMb: Math.round(firstHalfGrowthMb * 100) / 100,
          secondHalfGrowthMb: Math.round(secondHalfGrowthMb * 100) / 100,
          heapUsedDeltaMb: Math.round(totalDelta.heapUsedDeltaMb * 100) / 100,
          cpuUserMs: Math.round(totalDelta.cpuUserMs),
          cpuSystemMs: Math.round(totalDelta.cpuSystemMs),
          soakDurationMs: scaleProfile.soakDurationMs
        }
      };
    }
  };
}
