/**
 * Registry-wide forbidden-cross-import gate (Issue #685, epic #679
 * platform-hardening — "module DAG and forbidden-cross-import gates").
 *
 * `tests/unit/module-boundary.test.ts` (Issue #681) only ever guarded ONE
 * hardcoded pair (blog_content <-> news_portal), because that's the pair
 * an actual incident happened to involve — it does not generalize to any
 * other module. This file closes that gap for the WHOLE `src/modules/*`
 * registry: for every pair of modules, if A's source trees
 * (`MODULE_SOURCE_DIRS`) import B's AND B's import A's back, that's a
 * source-level import CYCLE — exactly the disease #681 fixed for one pair,
 * generalized to catch a future recurrence between any two modules.
 *
 * Deliberately narrower than "flag every cross-module import": a probe run
 * during this issue's implementation found several genuine, ONE-DIRECTIONAL
 * cross-module imports already in the codebase today (e.g. `blog-content ->
 * logging`, `news-portal -> module-management`) that are not cycles and are
 * not causing the lifecycle-ordering/circular-dependency bugs #680/#681
 * exist to prevent. Cycle detection is the check that's both
 * zero-false-positive against the CURRENT codebase and directly targets the
 * actual failure mode this epic's #680/#681 fixed.
 *
 * The "must appear in `dependencies`" rule this file's original header
 * explicitly declined to attempt (18 pre-existing undeclared edges — "a
 * wall of pre-existing findings") DOES now exist, as its own separate gate:
 * `tests/unit/module-declared-dependencies.test.ts` (Issue #826), which
 * ratchets that wall down from a frozen baseline rather than demanding it
 * be cleared at once. That gate is what catches the OTHER half of #826's
 * defect — an undeclared edge means `bun run modules:dag:check` validates a
 * graph that simply does not contain the edge, so it can report a valid DAG
 * over a real cycle.
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
 *
 * Known limitation (inherited from `module-boundary.test.ts`'s own,
 * reviewer + security-auditor-reviewed disclosure on PR #702 — repeated
 * here since this file is the broader, more likely to be relied on going
 * forward of the two): this is a CI/build-time TEXT SCAN, not a real
 * import-graph resolver. It cannot catch a cycle hidden behind a
 * re-export CHAIN through a third file outside the scanned trees.
 *
 * That gap USED to be described here as "module A's `application/` code
 * imports a local `infrastructure/`/`api/` file that itself re-exports
 * module B's code" — which was not a hypothetical at all: those two trees
 * were genuinely unscanned, and #826 found a real cycle whose outgoing side
 * sat in exactly such an `infrastructure/` file. Since #826 scans them, the
 * remaining chain would have to route through a module-root file (e.g.
 * `module.ts`) or `_shared`. Closing that residual gap for good would need a
 * real module-graph tool (`ts-morph`, an ESLint `import/no-restricted-paths`
 * rule with proper resolution, etc.), not a text-pattern scan — a documented
 * follow-up, not blocking. Treat a "documented limitation" in this file as a
 * live hazard to go verify, not as a settled decision: the last one was
 * being violated in `main` while all 258 pairs passed green.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MODULES_ROOT = path.join(import.meta.dir, "../../src/modules");

/**
 * Every source tree a module owns (Issue #826). `infrastructure` and `api`
 * were NOT scanned until #826, and that blind spot was live: the outgoing
 * side of a real `domain_event_runtime <-> integration_hub` cycle sat in
 * `domain-event-runtime/infrastructure/consumer-registry.ts`, so
 * `aImportsB` read false and all 258 pairs passed over an actual cycle.
 * A module's `infrastructure`/`api` code is exactly as capable of creating
 * a lifecycle-ordering/circular-dependency bug as its `application`/
 * `domain` code — the scan was narrower than the disease for no defensible
 * reason. Widening it also shrinks (does not close) the re-export-chain
 * limitation disclosed below, since the most likely intermediate hop for
 * such a chain was itself an unscanned `infrastructure`/`api` file.
 */
const MODULE_SOURCE_DIRS = ["application", "domain", "infrastructure", "api"];

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
  const targetPath = `["'][^"']*${targetModuleDirName}/(?:${MODULE_SOURCE_DIRS.join("|")})/[^"']*["']`;
  const staticImportPattern = new RegExp(`from\\s+${targetPath}`);
  const dynamicImportPattern = new RegExp(`import\\s*\\(\\s*${targetPath}`);
  // Bare side-effect import (`import "…/x"`) — no `from`, no parentheses.
  // Issue #826 made these load-bearing: a module now registers its own
  // domain-event consumer via exactly this form, so a scanner blind to it
  // would miss the very edges #826 introduced.
  const sideEffectImportPattern = new RegExp(`import\\s+${targetPath}`);

  return (
    staticImportPattern.test(line) ||
    dynamicImportPattern.test(line) ||
    sideEffectImportPattern.test(line)
  );
}

/**
 * True if any file in any of `sourceModuleDirName`'s own source trees
 * (`MODULE_SOURCE_DIRS`) imports code from one of `targetModuleDirName`'s.
 */
export function moduleImportsModule(
  sourceModuleDirName: string,
  targetModuleDirName: string
): boolean {
  const files = MODULE_SOURCE_DIRS.flatMap((dir) =>
    listTsFiles(path.join(MODULES_ROOT, sourceModuleDirName, dir))
  );

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

  // Issue #826 — the three forms the pre-#826 scanner was blind to.
  test("catches an import from an infrastructure/ tree", () => {
    expect(
      lineImportsModuleDir(
        'import { x } from "../../logging/infrastructure/foo";',
        "logging"
      )
    ).toBe(true);
  });

  test("catches an import from an api/ tree", () => {
    expect(
      lineImportsModuleDir(
        'import { x } from "../../logging/api/foo";',
        "logging"
      )
    ).toBe(true);
  });

  test("catches a bare side-effect import", () => {
    expect(
      lineImportsModuleDir(
        'import "../../logging/infrastructure/domain-event-consumer-registration";',
        "logging"
      )
    ).toBe(true);
  });
});

describe("module boundary — no circular cross-module imports across the whole registry (Issue #685, widened to infrastructure/api by Issue #826)", () => {
  const moduleDirNames = listModuleDirNames();

  test("registry has more than one module to check (sanity check for this test itself)", () => {
    expect(moduleDirNames.length).toBeGreaterThan(1);
  });

  for (let i = 0; i < moduleDirNames.length; i++) {
    for (let j = i + 1; j < moduleDirNames.length; j++) {
      const a = moduleDirNames[i]!;
      const b = moduleDirNames[j]!;

      test(`${a} <-> ${b} is not a circular cross-module import`, () => {
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
