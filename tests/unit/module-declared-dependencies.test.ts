/**
 * Declared-vs-actual dependency drift gate (Issue #826).
 *
 * THE ROOT CAUSE #826 exists to close. `bun run modules:dag:check`
 * (`validateModuleDependencyGraph`, Issue #680) is a real cycle detector,
 * but it can only detect cycles among the edges it is GIVEN — and the edges
 * it is given come from each `ModuleDescriptor.dependencies` array, a
 * hand-maintained declaration that nothing ever checked against the code.
 * So a module could import another module's code without declaring it, the
 * declared graph would simply not contain that edge, and the check would
 * cheerfully report "23 registered modules form a valid DAG" while a real
 * import cycle ran in production. That is exactly what happened:
 * `domain-event-runtime/module.ts` declared `["tenant_admin",
 * "identity_access", "logging"]` while `infrastructure/consumer-registry.ts`
 * imported `integration_hub` and `reporting`. A cycle detector fed a graph
 * missing the cycle's own edge cannot fail. Both #826 gates were green over
 * a live cycle for this reason and the complementary one in
 * `module-boundary-cycles.test.ts`'s header.
 *
 * This gate makes the declaration answerable to the code: every real
 * cross-module import must appear in the importing module's declared
 * `dependencies`. With that true, `modules:dag:check` is finally validating
 * the graph the code actually forms.
 *
 * BASELINE, not a clean sweep. There are 16 pre-existing undeclared edges
 * across 10 modules (mostly `-> logging`, which ~13 modules import as
 * foundational infrastructure). Declaring them all is a real change to the
 * lifecycle-ordering graph for 10 modules at once and is NOT #826's scope —
 * that is the "wall of pre-existing findings" `module-boundary-cycles.test.ts`'s
 * original header cited when it declined this rule entirely. Freezing them
 * as an explicit, enumerated baseline is what lets the gate ship NOW and
 * close the root cause going forward: a NEW undeclared edge fails
 * immediately, which is precisely what would have caught #826 at authoring
 * time. The baseline can only shrink — an entry that is no longer needed
 * also fails, so it can never quietly become permanent cover.
 *
 * Follow-up (not #826): work the baseline to zero, then delete it and this
 * paragraph.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";

const MODULES_ROOT = path.join(import.meta.dir, "../../src/modules");
const MODULE_SOURCE_DIRS = ["application", "domain", "infrastructure", "api"];

// `_shared` is neutral ground (ports/kernel utilities) — an import of it is
// never a module dependency, which is the entire point of a port living
// there. Non-directory entries are registry/composition files, not modules.
const EXCLUDED_ENTRIES = new Set(["_shared"]);

/**
 * Pre-existing undeclared edges, frozen as of Issue #826 (`sourceDir ->
 * targetDir`). Every entry is a real import that its module does not
 * declare. NEVER add to this list to make a new import pass — declare the
 * dependency in the module's own `module.ts` instead, and if that creates a
 * cycle, that cycle is a real defect this gate just found for you.
 */
const UNDECLARED_EDGE_BASELINE: readonly string[] = [
  "blog-content -> module-management",
  "blog-content -> logging",
  "document-infrastructure -> logging",
  "form-drafts -> logging",
  "identity-access -> logging",
  "module-management -> logging",
  "module-management -> email",
  "news-portal -> logging",
  "news-portal -> module-management",
  "organization-structure -> logging",
  "profile-identity -> logging",
  "profile-identity -> domain-event-runtime",
  "reference-data -> logging",
  "social-publishing -> logging",
  "social-publishing -> blog-content",
  "social-publishing -> news-portal"
];

function listModuleDirNames(): string[] {
  return readdirSync(MODULES_ROOT)
    .filter((entry) => !EXCLUDED_ENTRIES.has(entry))
    .filter((entry) => statSync(path.join(MODULES_ROOT, entry)).isDirectory())
    .sort();
}

function listTsFiles(dir: string): string[] {
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);

    if (statSync(fullPath).isDirectory()) {
      files.push(...listTsFiles(fullPath));
    } else if (entry.endsWith(".ts") || entry.endsWith(".astro")) {
      files.push(fullPath);
    }
  }

  return files;
}

function lineImportsModuleDir(line: string, targetDir: string): boolean {
  const targetPath = `["'][^"']*${targetDir}/(?:${MODULE_SOURCE_DIRS.join("|")})/[^"']*["']`;

  return (
    new RegExp(`from\\s+${targetPath}`).test(line) ||
    new RegExp(`import\\s*\\(\\s*${targetPath}`).test(line) ||
    new RegExp(`import\\s+${targetPath}`).test(line)
  );
}

/**
 * Resolved from each module's OWN `module.ts`, never by transforming a
 * directory name into a key: `workflow-approval/module.ts` declares
 * `key: "workflow"`, so any dir-name-to-key guess silently drops that
 * module from the gate entirely (found while building this gate — a probe
 * that guessed reported `NO DESCRIPTOR: workflow-approval` and skipped it).
 */
async function loadDescriptorsByDir(): Promise<Map<string, ModuleDescriptor>> {
  const byDir = new Map<string, ModuleDescriptor>();

  for (const dir of listModuleDirNames()) {
    const moduleFile = path.join(MODULES_ROOT, dir, "module.ts");
    const loaded = (await import(moduleFile)) as Record<string, unknown>;
    const descriptor = Object.values(loaded).find(
      (value): value is ModuleDescriptor =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as ModuleDescriptor).key === "string"
    );

    if (descriptor) {
      byDir.set(dir, descriptor);
    }
  }

  return byDir;
}

function realImportEdges(sourceDir: string, allDirs: string[]): Set<string> {
  const files = MODULE_SOURCE_DIRS.flatMap((dir) =>
    listTsFiles(path.join(MODULES_ROOT, sourceDir, dir))
  );
  const targets = new Set<string>();

  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");

    for (const targetDir of allDirs) {
      if (targetDir === sourceDir || targets.has(targetDir)) {
        continue;
      }

      if (lines.some((line) => lineImportsModuleDir(line, targetDir))) {
        targets.add(targetDir);
      }
    }
  }

  return targets;
}

describe("declared dependencies match real cross-module imports (Issue #826)", () => {
  test("every real cross-module import is declared, except the frozen baseline", async () => {
    const dirs = listModuleDirNames();
    const descriptors = await loadDescriptorsByDir();
    const keyToDir = new Map(
      [...descriptors.entries()].map(([dir, descriptor]) => [
        descriptor.key,
        dir
      ])
    );

    const violations: string[] = [];

    for (const sourceDir of dirs) {
      const descriptor = descriptors.get(sourceDir);

      expect(
        descriptor,
        `${sourceDir}/module.ts exposes no ModuleDescriptor`
      ).toBeDefined();

      const declaredDirs = new Set(
        (descriptor!.dependencies ?? []).map((key) => keyToDir.get(key) ?? key)
      );

      for (const targetDir of realImportEdges(sourceDir, dirs)) {
        const edge = `${sourceDir} -> ${targetDir}`;

        if (
          !declaredDirs.has(targetDir) &&
          !UNDECLARED_EDGE_BASELINE.includes(edge)
        ) {
          violations.push(
            `${edge}: ${sourceDir} imports ${targetDir}'s code but ${sourceDir}/module.ts does not declare it in \`dependencies\`. ` +
              `Declare it. If declaring it makes \`bun run modules:dag:check\` fail, you have found a REAL cycle — break it, don't hide it here.`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the baseline only shrinks — every frozen entry is still a real undeclared edge", async () => {
    const dirs = listModuleDirNames();
    const descriptors = await loadDescriptorsByDir();
    const keyToDir = new Map(
      [...descriptors.entries()].map(([dir, descriptor]) => [
        descriptor.key,
        dir
      ])
    );

    const liveEdges = new Set<string>();

    for (const sourceDir of dirs) {
      const declaredDirs = new Set(
        (descriptors.get(sourceDir)?.dependencies ?? []).map(
          (key) => keyToDir.get(key) ?? key
        )
      );

      for (const targetDir of realImportEdges(sourceDir, dirs)) {
        if (!declaredDirs.has(targetDir)) {
          liveEdges.add(`${sourceDir} -> ${targetDir}`);
        }
      }
    }

    const stale = UNDECLARED_EDGE_BASELINE.filter(
      (edge) => !liveEdges.has(edge)
    );

    expect(
      stale,
      `These baseline entries are no longer real undeclared edges — delete them from UNDECLARED_EDGE_BASELINE:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  test("domain_event_runtime declares no feature module (the Issue #826 regression itself)", async () => {
    const descriptors = await loadDescriptorsByDir();
    const declared =
      descriptors.get("domain-event-runtime")?.dependencies ?? [];

    // A `system`-type foundation module must never depend on a feature
    // module that plugs into it (ADR-0013 §1). Both of these were REAL
    // imports before #826 inverted the registration; either one declared
    // here re-creates a declared-graph cycle, since both modules declare
    // `domain_event_runtime` themselves.
    expect(declared).not.toContain("integration_hub");
    expect(declared).not.toContain("reporting");
  });
});
