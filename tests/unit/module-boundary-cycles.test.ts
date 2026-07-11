/**
 * Registry-wide forbidden-cross-import gate (Issue #685, epic #679
 * platform-hardening — "module DAG and forbidden-cross-import gates").
 *
 * `tests/unit/module-boundary.test.ts` (Issue #681) only ever guarded ONE
 * hardcoded pair (blog_content <-> news_portal), because that's the pair
 * an actual incident happened to involve — it does not generalize to any
 * other module. This file closes that gap for the WHOLE `src/modules/*`
 * registry: for every pair of modules, if A's `application`/`domain` tree
 * imports B's `application`/`domain` tree AND B's imports A's back, that's
 * a source-level import CYCLE — exactly the disease #681 fixed for one
 * pair, generalized to catch a future recurrence between any two modules.
 *
 * Deliberately narrower than "flag every cross-module import": a probe run
 * during this issue's implementation found several genuine, ONE-DIRECTIONAL
 * cross-module `application`/`domain` imports already in the codebase
 * today (e.g. `blog-content -> logging`, `news-portal -> module-management`)
 * that are not cycles and are not causing the lifecycle-ordering/circular-
 * dependency bugs #680/#681 exist to prevent — a blanket "must appear in
 * `dependencies`" rule would have produced a wall of pre-existing, unrelated
 * findings unrelated to this issue's actual scope (see `.claude/skills/
 * awcms-mini-platform-hardening/SKILL.md` if that broader audit is ever
 * picked up as its own issue; not attempted here). Cycle detection is the
 * check that's both zero-false-positive against the CURRENT codebase (a
 * probe run found none) and directly targets the actual failure mode this
 * epic's #680/#681 fixed.
 *
 * Complements — does NOT replace — `bun run modules:dag:check`
 * (`validateModuleDependencyGraph`, Issue #680): that check finds cycles in
 * the DECLARED `ModuleDescriptor.dependencies` graph (what modules SAY they
 * depend on); this one finds cycles in the ACTUAL source-level import graph
 * (what modules' code really reaches into) — the two are independent and a
 * codebase could pass one while failing the other (exactly what happened
 * before #681: the declared-dependency graph never had a blog_content <->
 * news_portal edge at all, so `modules:dag:check` alone could never have
 * caught that cycle).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MODULES_ROOT = path.join(import.meta.dir, "../../src/modules");

// `_shared` is neutral ground (ports/kernel utilities, not a module with its
// own `application`/`domain` tree in the same sense) and `index.ts` is the
// registry file, not a module directory — both excluded from the pairwise
// scan.
const EXCLUDED_ENTRIES = new Set(["_shared", "index.ts"]);

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
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...listTsFiles(fullPath));
    } else if (entry.endsWith(".ts") || entry.endsWith(".astro")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Same matching semantics as `module-boundary.test.ts`'s
 * `lineViolatesModuleBoundary` (static `from "..."` and dynamic
 * `import("...")`), generalized to accept any target module directory
 * name rather than a hardcoded one — exported so the pattern itself is
 * independently unit-testable against synthetic lines.
 */
export function lineImportsModuleDir(
  line: string,
  targetModuleDirName: string
): boolean {
  const staticImportPattern = new RegExp(
    `from\\s+["'][^"']*${targetModuleDirName}/(?:application|domain)/[^"']*["']`
  );
  const dynamicImportPattern = new RegExp(
    `import\\s*\\(\\s*["'][^"']*${targetModuleDirName}/(?:application|domain)/[^"']*["']`
  );

  return staticImportPattern.test(line) || dynamicImportPattern.test(line);
}

/**
 * True if any `application`/`domain` file under `sourceModuleDirName`
 * imports `application`/`domain` code from `targetModuleDirName`.
 */
export function moduleImportsModule(
  sourceModuleDirName: string,
  targetModuleDirName: string
): boolean {
  const appDomainDirs = [
    path.join(MODULES_ROOT, sourceModuleDirName, "application"),
    path.join(MODULES_ROOT, sourceModuleDirName, "domain")
  ];
  const files = appDomainDirs.flatMap(listTsFiles);

  return files.some((file) =>
    readFileSync(file, "utf-8")
      .split("\n")
      .some((line) => lineImportsModuleDir(line, targetModuleDirName))
  );
}

describe("lineImportsModuleDir (pattern correctness)", () => {
  test("catches a static import", () => {
    expect(
      lineImportsModuleDir(
        'import { x } from "../../logging/application/foo";',
        "logging"
      )
    ).toBe(true);
  });

  test("catches a dynamic import()", () => {
    expect(
      lineImportsModuleDir(
        'await import("../../logging/domain/foo");',
        "logging"
      )
    ).toBe(true);
  });

  test("does not false-positive on a prose comment", () => {
    expect(
      lineImportsModuleDir("// see logging/application/foo.ts", "logging")
    ).toBe(false);
  });

  test("does not flag an import from a DIFFERENT module of the same name prefix", () => {
    expect(
      lineImportsModuleDir(
        'import { x } from "../../logging-extra/application/foo";',
        "logging"
      )
    ).toBe(false);
  });
});

describe("module boundary — no circular application/domain imports across the whole registry (Issue #685)", () => {
  const moduleDirNames = listModuleDirNames();

  test("registry has more than one module to check (sanity check for this test itself)", () => {
    expect(moduleDirNames.length).toBeGreaterThan(1);
  });

  for (let i = 0; i < moduleDirNames.length; i++) {
    for (let j = i + 1; j < moduleDirNames.length; j++) {
      const a = moduleDirNames[i]!;
      const b = moduleDirNames[j]!;

      test(`${a} <-> ${b} is not a circular application/domain import`, () => {
        const aImportsB = moduleImportsModule(a, b);
        const bImportsA = moduleImportsModule(b, a);

        if (aImportsB && bImportsA) {
          throw new Error(
            `Circular import: ${a} imports ${b}'s application/domain code AND ${b} imports ${a}'s back. ` +
              `Break the cycle with a capability port in src/modules/_shared/ports/ (see ADR-0011 and Issue #681's resolution).`
          );
        }

        expect(aImportsB && bImportsA).toBe(false);
      });
    }
  }
});
