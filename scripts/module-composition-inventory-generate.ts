/**
 * module-composition-inventory-generate.ts — `bun run
 * modules:composition:inventory:generate`.
 *
 * Issue #740 (epic #738 `platform-evolution`, Wave 1). Generates a single,
 * deterministic, machine-readable snapshot of the COMPOSED module registry
 * (base + this repository's own build-time application registry,
 * `src/modules/application-registry.ts`) for CI/release evidence —
 * `docs/awcms-mini/module-composition-inventory.json`. A derived repository
 * that has replaced `application-registry.ts` with its own
 * `ApplicationModuleRegistry` would regenerate this same file to get
 * release evidence for ITS OWN composed registry (base + its application
 * modules), using the exact same script.
 *
 * Same "pure function of committed source, no wall-clock timestamp"
 * freshness design as `scripts/repo-inventory-generate.ts` (see that
 * file's own header for the full reasoning) — enforced the same way by the
 * read-only twin, `scripts/module-composition-inventory-check.ts`
 * (`bun run modules:composition:inventory:check`, part of `bun run
 * check`).
 *
 * Deliberately separate from `docs/awcms-mini/repo-inventory.md`
 * (Markdown, for humans, one section per repository-level concern):
 * this file is JSON, specifically scoped to the composed module registry,
 * intended to be diffed/parsed by CI or a derived repository's own release
 * tooling — not prose.
 *
 * Local/offline only: no network access, no external CLI — pure in-memory
 * computation over the already-imported module registry.
 */
import prettier from "prettier";

import { listBaseModules } from "../src/modules";
import { applicationModuleRegistry } from "../src/modules/application-registry";
import { buildComposedModuleInventory } from "../src/modules/module-management/domain/module-composition";

export const MODULE_COMPOSITION_INVENTORY_PATH =
  "docs/awcms-mini/module-composition-inventory.json";

/**
 * Runs the raw JSON through this project's own Prettier config before
 * returning — same reasoning `scripts/repo-inventory-generate.ts` documents
 * for its own raw->Prettier step: without it, every regeneration would need
 * a separate manual `bun run format` pass, and the committed file would
 * drift from what `module-composition-inventory-check.ts` regenerates in
 * memory (`bun run lint`/`bun run format` already enforce Prettier style on
 * every committed `.json` file repo-wide).
 */
export async function buildModuleCompositionInventoryJson(
  rootDir = process.cwd()
): Promise<string> {
  const inventory = buildComposedModuleInventory({
    base: listBaseModules(),
    application: applicationModuleRegistry
  });

  const raw = JSON.stringify(inventory, null, 2);
  const filepath = `${rootDir}/${MODULE_COMPOSITION_INVENTORY_PATH}`;
  const config = (await prettier.resolveConfig(filepath)) ?? {};

  return prettier.format(raw, { ...config, filepath, parser: "json" });
}

if (import.meta.main) {
  const { writeFile } = await import("node:fs/promises");
  const json = await buildModuleCompositionInventoryJson();
  await writeFile(MODULE_COMPOSITION_INVENTORY_PATH, json, "utf8");
  console.log(
    `Diperbarui: ${MODULE_COMPOSITION_INVENTORY_PATH}. Jalankan \`bun run modules:composition:inventory:check\` untuk verifikasi.`
  );
}
