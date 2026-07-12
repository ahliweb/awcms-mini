/**
 * Read-only freshness gate for `docs/awcms-mini/repo-inventory.md` (Issue
 * #688, epic #679 platform-hardening).
 *
 * `scripts/repo-inventory-generate.ts` (`bun run repo:inventory:generate`)
 * regenerates the inventory doc from the module registry, `sql/*.sql`
 * migrations, `tests/`, and the bundled OpenAPI contract — but it's a
 * MUTATION (it rewrites the file), so it can't be part of `bun run check`
 * directly, same reasoning as `scripts/api-docs-check.ts` (Issue #700) and
 * `scripts/i18n-pot-check.ts` (Issue #694). This script is the read-only
 * twin: it regenerates the Markdown in memory and diffs it against the
 * COMMITTED file, failing loudly if a module/migration/table/test change
 * landed without regenerating and committing the inventory doc.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  REPO_INVENTORY_PATH,
  buildRepoInventoryMarkdown
} from "./repo-inventory-generate";

export async function runRepoInventoryCheck(
  rootDir = process.cwd()
): Promise<string[]> {
  const committedPath = path.join(rootDir, REPO_INVENTORY_PATH);

  let committed: string;
  try {
    committed = await readFile(committedPath, "utf8");
  } catch {
    return [
      `${REPO_INVENTORY_PATH} is missing — run \`bun run repo:inventory:generate\` and commit the result.`
    ];
  }

  const fresh = await buildRepoInventoryMarkdown(rootDir);

  if (fresh === committed) return [];

  return [
    `${REPO_INVENTORY_PATH} does not match a fresh regeneration from the module registry/migrations/tests/bundled contract — run \`bun run repo:inventory:generate\` and commit the result (a module, migration, table, test, or route change likely landed without regenerating the inventory doc).`
  ];
}

if (import.meta.main) {
  const problems = await runRepoInventoryCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(`\nrepo:inventory:check GAGAL — ${problems.length} temuan.`);
    process.exitCode = 1;
  } else {
    console.log(
      "repo:inventory:check OK — docs/awcms-mini/repo-inventory.md matches a fresh regeneration."
    );
  }
}
