/**
 * Gate: cross-module runtime imports must be declared in `dependencies`.
 *
 * Covers `scripts/validate-module-imports.ts` (`bun run modules:imports:check`).
 *
 * WHY THE PURE FUNCTION IS TESTED, NOT JUST THE SCRIPT. Running the real gate
 * proves the repo is currently clean; it does NOT prove the gate can fail. Those
 * are different claims, and only the second one makes it a gate. Every rule below
 * is therefore exercised against synthetic edges, including the two shapes that
 * are awkward to stage on disk (a `_shared` inversion and an unmapped directory).
 *
 * The last test also runs the gate for real against the live registry, so the
 * invariant itself stays asserted rather than assumed.
 */
import { describe, expect, test } from "bun:test";

import {
  computeImportViolations,
  type ResolvedImportEdge
} from "../../scripts/validate-module-imports";

const dirToKey = new Map([
  ["blog-content", "blog_content"],
  ["identity-access", "identity_access"],
  ["service-catalog", "service_catalog"],
  // The real divergence this gate must not get wrong: directory != key.
  ["workflow-approval", "workflow"]
]);

function deps(
  entries: Record<string, string[]>
): Map<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(entries).map(([key, list]) => [key, new Set(list)])
  );
}

function edge(
  fromDir: string,
  toDir: string,
  specifier = `../../${toDir}/domain/thing`
): ResolvedImportEdge {
  return { fromDir, toDir, file: `src/modules/${fromDir}/x.ts`, specifier };
}

describe("cross-module import gate", () => {
  test("an undeclared runtime import is a violation", () => {
    const violations = computeImportViolations({
      edges: [edge("blog-content", "identity-access")],
      dirToKey,
      dependenciesByKey: deps({ blog_content: [] })
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "undeclared_dependency",
      fromKey: "blog_content",
      toKey: "identity_access"
    });
  });

  test("the same import is clean once declared", () => {
    const violations = computeImportViolations({
      edges: [edge("blog-content", "identity-access")],
      dirToKey,
      dependenciesByKey: deps({ blog_content: ["identity_access"] })
    });

    expect(violations).toEqual([]);
  });

  test("declaring a DIFFERENT module does not satisfy the edge", () => {
    // Guards against a check that merely asserts "has some dependencies".
    const violations = computeImportViolations({
      edges: [edge("blog-content", "identity-access")],
      dirToKey,
      dependenciesByKey: deps({ blog_content: ["service_catalog"] })
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ toKey: "identity_access" });
  });

  test("directory name is resolved to the descriptor key, not string-transformed", () => {
    // `workflow-approval/` declares key `workflow`. A dir.replace("-","_")
    // transform would look for `workflow_approval`, find nothing, and either
    // miss this violation or invent a bogus one.
    const violations = computeImportViolations({
      edges: [edge("workflow-approval", "identity-access")],
      dirToKey,
      dependenciesByKey: deps({ workflow: [] })
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      fromKey: "workflow",
      toKey: "identity_access"
    });

    const declared = computeImportViolations({
      edges: [edge("workflow-approval", "identity-access")],
      dirToKey,
      dependenciesByKey: deps({ workflow: ["identity_access"] })
    });
    expect(declared).toEqual([]);
  });

  test("imports INTO _shared never need declaring — that is the port seam", () => {
    const violations = computeImportViolations({
      edges: [edge("blog-content", "_shared")],
      dirToKey,
      dependenciesByKey: deps({ blog_content: [] })
    });

    expect(violations).toEqual([]);
  });

  test("_shared importing a concrete module is its own violation (ADR-0011, #859)", () => {
    const violations = computeImportViolations({
      edges: [edge("_shared", "blog-content")],
      dirToKey,
      dependenciesByKey: deps({})
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "shared_depends_on_module",
      toDir: "blog-content"
    });
  });

  test("self-edges inside one module are not cross-module", () => {
    const violations = computeImportViolations({
      edges: [edge("blog-content", "blog-content", "./other")],
      dirToKey,
      dependenciesByKey: deps({ blog_content: [] })
    });

    expect(violations).toEqual([]);
  });

  test("a directory with no resolvable descriptor fails loudly rather than being skipped", () => {
    // Silently ignoring an unmappable directory is how a whole module's
    // imports stop being checked without anyone noticing.
    const violations = computeImportViolations({
      edges: [],
      dirToKey,
      dependenciesByKey: deps({}),
      unmappedDirectories: ["mystery-module"]
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "unmapped_directory",
      dir: "mystery-module"
    });
  });

  test("every violating edge is reported, not just the first per module", () => {
    const violations = computeImportViolations({
      edges: [
        edge("blog-content", "identity-access", "../../identity-access/a"),
        edge("blog-content", "identity-access", "../../identity-access/b"),
        edge("blog-content", "service-catalog", "../../service-catalog/c")
      ],
      dirToKey,
      dependenciesByKey: deps({ blog_content: [] })
    });

    expect(violations).toHaveLength(3);
  });

  test("the live registry currently satisfies the invariant", async () => {
    const proc = Bun.spawn(["bun", "scripts/validate-module-imports.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    expect(`${out}${err}`).toContain("modules:imports:check OK");
    expect(code).toBe(0);
  });
});
