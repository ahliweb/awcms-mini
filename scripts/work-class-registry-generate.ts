/**
 * work-class-registry-generate.ts — `bun run db:work-class:generate`.
 *
 * Issue #743 (epic #738, platform-evolution, Wave 1). Generates
 * `docs/awcms-mini/work-class-registry.generated.json`: a full snapshot of
 * which database work class (`src/lib/database/work-class.ts`) every API
 * route and background job in this repository is classified as — the
 * "endpoint/operation-to-work-class registry" the issue's scope asks for.
 *
 * Same generate/check split as `repo-inventory-generate.ts`/
 * `repo-inventory-check.ts` (Issue #688) and `i18n-extract.ts`/
 * `i18n-pot-check.ts` (Issue #694): this script MUTATES (writes) the
 * snapshot, so it cannot be part of `bun run check` directly;
 * `work-class-registry-check.ts` is the read-only twin that regenerates in
 * memory and diffs against the committed file.
 *
 * ## What counts as "requires classification" (mechanical, not judgment)
 *
 * - **Routes**: every `src/pages/api/v1/**\/*.ts` file whose source calls
 *   `withTenant(` — that call is the ONLY thing `work-class.ts`'s
 *   concurrency gate is wired to (`tenant-context.ts`), so a route that
 *   never calls it (health checks, the one-time setup wizard) genuinely
 *   never goes through the gate and is correctly auto-exempted, not
 *   silently skipped. When a `workClass: "..."` literal is present it is
 *   extracted verbatim ("explicit"); otherwise the route relies on
 *   `withTenant`'s documented default, `"interactive"` ("default"). Either
 *   way it is REPRESENTED in the snapshot — "classified as interactive by
 *   default" is still a recorded, reviewable decision, and a NEW route
 *   changes this file's content, which `work-class-registry-check.ts` will
 *   catch if not regenerated and committed.
 * - **Jobs**: every `scripts/*.ts` file whose source calls
 *   `getWorkerDatabaseClient(`/`getSetupDatabaseClient(` — ground truth for
 *   "this process opens a pooled, budget-relevant database connection",
 *   independent of whether a module's `jobs:` descriptor also happens to
 *   list it (verified during Issue #743 implementation: it does not,
 *   for `visitor-analytics-rollup.ts`/`visitor-analytics-purge.ts` — an
 *   unrelated, pre-existing gap in that module's own documentation, out of
 *   this issue's scope to fix). Every discovered job MUST have a matching
 *   entry in `src/lib/database/work-class-registry.ts`'s
 *   `JOB_WORK_CLASS_REGISTRY` — this script REFUSES to write a snapshot
 *   (throws) if one is missing, rather than emitting a placeholder that
 *   could be silently committed.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  JOB_WORK_CLASS_REGISTRY,
  type JobWorkClassEntry
} from "../src/lib/database/work-class-registry";
import type { WorkClass } from "../src/lib/database/work-class";

export const WORK_CLASS_REGISTRY_PATH =
  "docs/awcms-mini/work-class-registry.generated.json";

const ROUTES_ROOT = "src/pages/api/v1";
const JOBS_ROOT = "scripts";
const DEFAULT_ROUTE_WORK_CLASS: WorkClass = "interactive";

/**
 * Security-auditor finding on PR #770 (Issue #743): detects a `withTenant(`
 * CALL, not just the literal substring `"withTenant("`. The original
 * `source.includes("withTenant(")` check missed every call site written
 * with an explicit generic type argument — `withTenant<T>(...)` — because
 * that literal 13-character substring never appears when there's a `<T>`
 * between the name and the opening paren. This was not theoretical:
 * `src/pages/api/v1/media/news-images/upload-sessions/index.ts` calls
 * `await withTenant<CreateTxResult>(...)` today, and was silently absent
 * from the generated registry as a result — a deterministic false negative
 * that "regenerate and diff" alone could never catch (the generator itself
 * was wrong, so it always regenerated to the same wrong, self-consistent
 * answer).
 *
 * `\bwithTenant` — word boundary, so this doesn't match `useWithTenant`/
 * `withTenantId`-style false positives (none exist today, defense in depth).
 * `\s*(?:<[^()]*>)?\s*\(` — an OPTIONAL generic type argument (any content
 * without parens — TypeScript type arguments essentially never contain a
 * paren; a function-type argument like `<(x: number) => void>` would defeat
 * this, but no such call site exists, verified by grep), then the opening
 * paren of the call itself.
 *
 * A regex, not a TypeScript-compiler/AST-based check, deliberately —
 * consistent with every other source-scanning gate in this repo
 * (`logging-lint-check.ts`, `security-readiness.ts`'s secret scanner):
 * simple, auditable in a code review, no new dependency, and this specific,
 * narrow gap (an optional `<...>` before the call parens) is fully closed
 * by a regex without needing full parse/type information. A renamed import
 * (`import { withTenant as wt }`) would still defeat this heuristic — no
 * such call site exists in this repo today (verified by grep); documented
 * as a known limitation of the mechanical approach, same as this file's
 * other heuristics.
 */
const WITH_TENANT_CALL_PATTERN = /\bwithTenant\s*(?:<[^()]*>)?\s*\(/;

/**
 * This script's own file is excluded from job-discovery — its doc comments
 * above legitimately name `getWorkerDatabaseClient(`/`getSetupDatabaseClient(`
 * in prose (explaining what the scanner looks for), which would otherwise
 * make the scanner detect ITSELF as an unclassified job. Same
 * self-exclusion precedent as `security-readiness.ts`'s
 * `SECRET_SCAN_SELF_EXCLUDE`.
 */
const JOB_SCAN_SELF_EXCLUDE = "scripts/work-class-registry-generate.ts";

const WORK_CLASS_LITERAL_PATTERN = /workClass:\s*"([a-z_]+)"/;

async function walkFiles(dir: string, extension: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, extension)));
    } else if (
      entry.name.endsWith(extension) &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(full);
    }
  }

  return files;
}

export type RouteWorkClassEntry = {
  path: string;
  workClass: WorkClass;
  source: "explicit" | "default";
};

export type JobWorkClassSnapshotEntry = {
  path: string;
  workClass: WorkClass;
  source: "registry";
  rationale: string;
};

export type WorkClassRegistrySnapshot = {
  routes: RouteWorkClassEntry[];
  jobs: JobWorkClassSnapshotEntry[];
};

/** Pure over already-read file contents — exported so both this script and its tests can build a snapshot from an arbitrary `{ path: content }` map without touching disk. */
export function classifyRoute(
  relativePath: string,
  source: string
): RouteWorkClassEntry | null {
  if (!WITH_TENANT_CALL_PATTERN.test(source)) {
    return null;
  }

  const match = WORK_CLASS_LITERAL_PATTERN.exec(source);

  return match
    ? {
        path: relativePath,
        workClass: match[1] as WorkClass,
        source: "explicit"
      }
    : {
        path: relativePath,
        workClass: DEFAULT_ROUTE_WORK_CLASS,
        source: "default"
      };
}

/** Throws when a discovered job file has no `JOB_WORK_CLASS_REGISTRY` entry — see file header on why this refuses to write a placeholder. */
export function classifyJob(
  relativePath: string,
  source: string
): JobWorkClassSnapshotEntry | null {
  const opensWorkerConnection =
    source.includes("getWorkerDatabaseClient(") ||
    source.includes("getSetupDatabaseClient(");

  if (!opensWorkerConnection) {
    return null;
  }

  const entry = JOB_WORK_CLASS_REGISTRY[relativePath];

  if (!entry) {
    throw new Error(
      `${relativePath} opens a worker/setup database connection but has no entry in ` +
        "src/lib/database/work-class-registry.ts's JOB_WORK_CLASS_REGISTRY — add one " +
        "(workClass + rationale) before regenerating."
    );
  }

  return {
    path: relativePath,
    workClass: entry.workClass,
    source: "registry",
    rationale: entry.rationale
  };
}

/**
 * Pure — the other half of `classifyJob`'s "missing entry" throw: which
 * `registry` keys have NO corresponding entry in `discoveredJobPaths`
 * (a path that was deleted, renamed, or no longer opens a worker/setup
 * connection). Exported and parameterized (rather than reaching for the
 * real `JOB_WORK_CLASS_REGISTRY`/file tree directly) so this can be unit
 * tested with a synthetic registry, without needing an actual stale entry
 * to exist in this repo.
 */
export function findStaleJobRegistryEntries(
  discoveredJobPaths: readonly string[],
  registry: Readonly<Record<string, JobWorkClassEntry>>
): string[] {
  const discovered = new Set(discoveredJobPaths);

  return Object.keys(registry).filter(
    (registeredPath) => !discovered.has(registeredPath)
  );
}

export async function buildWorkClassRegistrySnapshot(
  rootDir = process.cwd()
): Promise<WorkClassRegistrySnapshot> {
  const routeFiles = await walkFiles(path.join(rootDir, ROUTES_ROOT), ".ts");
  const jobFiles = await walkFiles(path.join(rootDir, JOBS_ROOT), ".ts");

  const routes: RouteWorkClassEntry[] = [];

  for (const file of routeFiles) {
    const relativePath = path.relative(rootDir, file).split(path.sep).join("/");
    const content = await readFile(file, "utf8");
    const entry = classifyRoute(relativePath, content);

    if (entry) {
      routes.push(entry);
    }
  }

  const jobs: JobWorkClassSnapshotEntry[] = [];

  for (const file of jobFiles) {
    const relativePath = path.relative(rootDir, file).split(path.sep).join("/");

    if (relativePath === JOB_SCAN_SELF_EXCLUDE) {
      continue;
    }

    const content = await readFile(file, "utf8");
    const entry = classifyJob(relativePath, content);

    if (entry) {
      jobs.push(entry);
    }
  }

  // Reviewer finding on PR #770: this file's header comment claims a stale
  // `JOB_WORK_CLASS_REGISTRY` entry (a path that no longer exists, or no
  // longer opens a worker/setup connection) makes the check fail — that
  // wasn't actually implemented; only the opposite direction (a discovered
  // file missing an entry) threw. This closes the other direction, so the
  // header comment's claim is now true rather than aspirational.
  const staleRegistryEntries = findStaleJobRegistryEntries(
    jobs.map((entry) => entry.path),
    JOB_WORK_CLASS_REGISTRY
  );

  if (staleRegistryEntries.length > 0) {
    throw new Error(
      "src/lib/database/work-class-registry.ts's JOB_WORK_CLASS_REGISTRY has " +
        `${staleRegistryEntries.length} stale entr${staleRegistryEntries.length === 1 ? "y" : "ies"} ` +
        `for a path that no longer exists or no longer opens a worker/setup database connection: ` +
        `${staleRegistryEntries.join(", ")}. Remove the entry (or restore the connection call) before regenerating.`
    );
  }

  routes.sort((a, b) => a.path.localeCompare(b.path));
  jobs.sort((a, b) => a.path.localeCompare(b.path));

  return { routes, jobs };
}

/**
 * Deterministic JSON text (2-space indent, trailing newline, no embedded
 * timestamp — same "freshness enforced structurally" reasoning as
 * `repo-inventory-generate.ts`) so `work-class-registry-check.ts` can do a
 * plain string-equality diff against the committed file.
 */
export async function buildWorkClassRegistryJson(
  rootDir = process.cwd()
): Promise<string> {
  const snapshot = await buildWorkClassRegistrySnapshot(rootDir);

  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function main() {
  const json = await buildWorkClassRegistryJson();

  await writeFile(WORK_CLASS_REGISTRY_PATH, json, "utf8");

  console.log(
    `Wrote ${WORK_CLASS_REGISTRY_PATH} (${JSON.parse(json).routes.length} route(s), ` +
      `${JSON.parse(json).jobs.length} job(s)).`
  );
}

if (import.meta.main) {
  await main();
}
