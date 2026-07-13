/**
 * Read-only freshness gate for
 * `docs/awcms-mini/work-class-registry.generated.json` (Issue #743, epic
 * #738 platform-evolution) — `bun run db:work-class:check`, part of
 * `bun run check`.
 *
 * Same idiom as `repo-inventory-check.ts` (Issue #688): regenerates the
 * snapshot in memory from the current source tree and diffs it against the
 * COMMITTED file, failing loudly if a route/job was added or reclassified
 * without regenerating and committing the registry. This is the actual "CI
 * check that prevents unclassified API routes/jobs" the issue's scope asks
 * for — a genuinely new/reclassified route or job changes the freshly
 * regenerated JSON, so it cannot silently merge without a reviewable diff
 * to this file.
 *
 * `buildWorkClassRegistryJson` itself throws (rather than returning a
 * placeholder) when a discovered job script has no
 * `JOB_WORK_CLASS_REGISTRY` entry — that failure mode is surfaced here too,
 * as a problem, distinct from a plain content mismatch.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  WORK_CLASS_REGISTRY_PATH,
  buildWorkClassRegistryJson
} from "./work-class-registry-generate";

export async function runWorkClassRegistryCheck(
  rootDir = process.cwd()
): Promise<string[]> {
  const committedPath = path.join(rootDir, WORK_CLASS_REGISTRY_PATH);

  let committed: string;

  try {
    committed = await readFile(committedPath, "utf8");
  } catch {
    return [
      `${WORK_CLASS_REGISTRY_PATH} is missing — run \`bun run db:work-class:generate\` and commit the result.`
    ];
  }

  let fresh: string;

  try {
    fresh = await buildWorkClassRegistryJson(rootDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`db:work-class:check FAIL — ${message}`];
  }

  if (fresh === committed) {
    return [];
  }

  return [
    `${WORK_CLASS_REGISTRY_PATH} does not match a fresh regeneration — run ` +
      "`bun run db:work-class:generate` and commit the result (a route or job was " +
      "likely added/reclassified without regenerating the work-class registry)."
  ];
}

if (import.meta.main) {
  const problems = await runWorkClassRegistryCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }

    console.error(
      `\ndb:work-class:check FAIL — ${problems.length} problem(s).`
    );
    process.exitCode = 1;
  } else {
    console.log("db:work-class:check OK.");
  }
}
