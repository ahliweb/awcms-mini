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

import { JOB_WORK_CLASS_REGISTRY } from "../src/lib/database/work-class-registry";
import type { WorkClass } from "../src/lib/database/work-class";

export const WORK_CLASS_REGISTRY_PATH =
  "docs/awcms-mini/work-class-registry.generated.json";

const ROUTES_ROOT = "src/pages/api/v1";
const JOBS_ROOT = "scripts";
const DEFAULT_ROUTE_WORK_CLASS: WorkClass = "interactive";

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
  if (!source.includes("withTenant(")) {
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
