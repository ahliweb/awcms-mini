/**
 * Performance report builder (Issue #744, epic #738 platform-evolution) —
 * produces the machine-readable JSON + human-readable Markdown artifacts
 * the issue's own acceptance criteria require ("Store machine-readable
 * results and a concise human report as CI/release artifacts", "Results
 * can be compared between two releases/commits with clear environment
 * metadata", "Document hardware/container/database configuration so
 * results are comparable, not presented as universal production
 * guarantees").
 *
 * Every value that reaches the JSON artifact passes through
 * `redaction.ts` before being written to disk: `redactDatabaseUrl` builds
 * `environment.databaseUrlRedacted` at the source, and `redactReport`
 * (below) additionally runs `redactDsnPatternsDeep` + `redactUuidsDeep` as
 * defensive backstops over the WHOLE report tree — not just that one
 * known field — in case any nested value (a scenario's `detail`, a
 * query-plan `finding`, a future scenario's own metrics) ever embeds a raw
 * connection string or tenant/user id, e.g. via an unsanitized thrown
 * `error.message`.
 */
import { cpus, platform, arch, totalmem } from "node:os";

import type { ScenarioResult } from "../resilience/scenario-runner";
import type { FixtureSeedSummary } from "./fixture-seeder";
import type { QueryPlanCheckResult } from "./query-plan-runner";
import type { PerformanceScaleProfile } from "./scale-profiles";
import { totalRowCount } from "./scale-profiles";
import {
  createIdRedactor,
  redactDatabaseUrl,
  redactDsnPatternsDeep,
  redactUuidsDeep
} from "./redaction";

export type PerformanceReportEnvironment = {
  generatedAt: string;
  appEnv: string | null;
  databaseUrlRedacted: string;
  scaleProfileId: string;
  scaleProfileLabel: string;
  tenantCount: number;
  noisyNeighborMultiplier: number;
  totalSeededRowsPlanned: number;
  hardware: {
    platform: string;
    arch: string;
    cpuCount: number;
    totalMemoryMb: number;
    bunVersion: string;
  };
  disclaimer: string;
};

export function buildEnvironmentMetadata(options: {
  appEnv: string | undefined;
  databaseUrl: string | undefined;
  scaleProfile: PerformanceScaleProfile;
}): PerformanceReportEnvironment {
  return {
    generatedAt: new Date().toISOString(),
    appEnv: options.appEnv ?? null,
    databaseUrlRedacted: redactDatabaseUrl(options.databaseUrl),
    scaleProfileId: options.scaleProfile.id,
    scaleProfileLabel: options.scaleProfile.label,
    tenantCount: options.scaleProfile.tenantCount,
    noisyNeighborMultiplier: options.scaleProfile.noisyNeighborMultiplier,
    totalSeededRowsPlanned: totalRowCount(options.scaleProfile),
    hardware: {
      platform: platform(),
      arch: arch(),
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
      bunVersion: Bun.version
    },
    disclaimer:
      "Numbers reflect THIS container/hardware/database configuration and " +
      "the synthetic fixture scale above — comparable release-to-release on " +
      "the SAME environment, not a universal production capacity guarantee " +
      "(doc 07 §Performance test awal makes the same disclosure for its own targets)."
  };
}

export type PerformanceReport = {
  environment: PerformanceReportEnvironment;
  tier: "safe" | "full";
  overall: "pass" | "incomplete" | "fail";
  scenarios: ScenarioResult[];
  queryPlanChecks: QueryPlanCheckResult[];
  seedSummary: FixtureSeedSummary | null;
};

/**
 * Redacts the WHOLE report tree — not just the one already-known
 * `environment.databaseUrl` field — before it is ever written to disk.
 * Security-auditor finding on PR #775: `environment.databaseUrlRedacted`
 * was built correctly via `redactDatabaseUrl` at the source, but nothing
 * previously scanned free-text fields (`ScenarioResult.detail`,
 * `QueryPlanCheckResult.findings`) for a DSN that could arrive there via a
 * raw, unsanitized `error.message` from a thrown error — `redactDsnPatternsDeep`
 * closes that gap. Runs DSN redaction first, then UUID redaction (a
 * redacted DSN's `<redacted>` placeholder can never itself look like a
 * UUID, so order only matters for keeping the two passes independent and
 * easy to reason about individually).
 */
export function redactReport(report: PerformanceReport): PerformanceReport {
  const redactor = createIdRedactor("id");
  const dsnRedacted = redactDsnPatternsDeep(report);
  return redactUuidsDeep(dsnRedacted, redactor) as PerformanceReport;
}

/**
 * Escapes a value for safe embedding in one Markdown table cell.
 * Backslash FIRST, then pipe — a recurring bug class in this repo's own
 * docs generators (shipped 3 times before this one, always caught by
 * CodeQL, never by tests/review): escaping `|` alone, without escaping a
 * pre-existing `\` first, lets a value ending in `\|` (e.g. a Windows-
 * style path fragment, or any string containing a literal backslash
 * immediately before a pipe) turn into `\\|` in the output — Markdown
 * reads that as an escaped backslash (`\\`) followed by an UNESCAPED
 * pipe (`|`), breaking out of the table cell. Escaping `\` -> `\\` before
 * `|` -> `\|` makes the two independent, in either order in the input.
 */
export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export function buildHumanReport(report: PerformanceReport): string {
  const lines: string[] = [];

  lines.push(`# AWCMS-Mini performance suite report`);
  lines.push("");
  lines.push(`- Generated: ${report.environment.generatedAt}`);
  lines.push(`- Tier: ${report.tier}`);
  lines.push(`- Overall: **${report.overall.toUpperCase()}**`);
  lines.push(`- APP_ENV: ${report.environment.appEnv ?? "(not set)"}`);
  lines.push(`- Database: ${report.environment.databaseUrlRedacted}`);
  lines.push(
    `- Scale profile: ${report.environment.scaleProfileId} (${report.environment.scaleProfileLabel})`
  );
  lines.push(
    `- Tenants: ${report.environment.tenantCount} (noisy-neighbor multiplier: ${report.environment.noisyNeighborMultiplier}x)`
  );
  lines.push(
    `- Planned total seeded rows: ${report.environment.totalSeededRowsPlanned}`
  );
  lines.push(
    `- Hardware: ${report.environment.hardware.platform}/${report.environment.hardware.arch}, ` +
      `${report.environment.hardware.cpuCount} CPU(s), ` +
      `${report.environment.hardware.totalMemoryMb}MB total memory, Bun ${report.environment.hardware.bunVersion}`
  );
  lines.push("");
  lines.push(`> ${report.environment.disclaimer}`);
  lines.push("");

  if (report.seedSummary) {
    lines.push(`## Fixture seed summary`);
    lines.push("");
    lines.push(`- Tenants seeded: ${report.seedSummary.tenantCount}`);
    lines.push(
      `- Seed duration: ${report.seedSummary.durationMs.toFixed(0)}ms`
    );
    for (const [table, count] of Object.entries(report.seedSummary.rowCounts)) {
      lines.push(`- ${table}: ${count} rows`);
    }
    lines.push("");
  }

  lines.push(`## Scenarios`);
  lines.push("");
  lines.push(`| Scenario | Tier | Status | Duration (ms) | Detail |`);
  lines.push(`| --- | --- | --- | ---: | --- |`);
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.name} | ${scenario.tier} | ${scenario.status.toUpperCase()} | ` +
        `${scenario.durationMs.toFixed(0)} | ${escapeMarkdownTableCell(scenario.detail)} |`
    );
  }
  lines.push("");

  if (report.queryPlanChecks.length > 0) {
    lines.push(`## Query-plan budgets`);
    lines.push("");
    lines.push(`| Budget | Status | Root cost | Execution (ms) | Findings |`);
    lines.push(`| --- | --- | ---: | ---: | --- |`);
    for (const check of report.queryPlanChecks) {
      lines.push(
        `| ${check.budgetId} | ${check.ok ? "PASS" : "FAIL"} | ${check.rootTotalCost.toFixed(1)} | ` +
          `${check.executionTimeMs === null ? "n/a" : check.executionTimeMs.toFixed(1)} | ` +
          `${check.findings.length > 0 ? escapeMarkdownTableCell(check.findings.join("; ")) : "(none)"} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
