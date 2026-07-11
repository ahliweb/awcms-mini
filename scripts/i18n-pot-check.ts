/**
 * Read-only freshness gate for `i18n/messages.pot` (Issue #694, epic #679
 * platform-hardening).
 *
 * `scripts/i18n-extract.ts` (`bun run i18n:extract`) regenerates
 * `messages.pot` from `src/` — but it's a MUTATION (it rewrites the file),
 * so it can't be part of `bun run check` directly (same reasoning
 * `scripts/check-docs.mjs`/`scripts/config-docs-check.ts` already
 * document for their own generate-vs-check split). This script is the
 * read-only twin: it runs the exact same extraction/render logic in
 * memory, diffs the result against the COMMITTED `i18n/messages.pot`, and
 * fails loudly if a contributor added/removed a `t("...")` call without
 * re-running `bun run i18n:extract` and committing the regenerated file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertNoDeadDynamicFamilies,
  buildPotContent,
  extractKeys,
  POT_PATH
} from "./i18n-extract";

export async function runI18nPotCheck(
  rootDir = process.cwd()
): Promise<string[]> {
  const { entries, dynamicPrefixesSeen } = await extractKeys(rootDir);

  assertNoDeadDynamicFamilies(dynamicPrefixesSeen);

  const generated = buildPotContent(entries);
  const committed = await readFile(path.join(rootDir, POT_PATH), "utf8");

  if (generated === committed) {
    return [];
  }

  return [
    `${POT_PATH} does not match deterministic extraction from src/ — regenerate with \`bun run i18n:extract\` and commit the result (a t("...") call was likely added, removed, or changed without regenerating the template).`
  ];
}

if (import.meta.main) {
  const problems = await runI18nPotCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }

    console.error(`\ni18n:pot:check GAGAL — ${problems.length} temuan.`);
    process.exitCode = 1;
  } else {
    console.log(
      "i18n:pot:check OK — i18n/messages.pot matches deterministic extraction from src/."
    );
  }
}
