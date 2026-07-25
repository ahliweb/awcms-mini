/**
 * Structural chokepoint guard for projection accessibility (Issue #880, epic
 * #868 Wave 3 operations).
 *
 * WHY THIS FILE EXISTS. Before #880 every registered `ProjectionDescriptor`
 * was owned by `reporting` — a base module every tenant always has — so
 * "does the caller hold this descriptor's `requiredPermission`?" was the
 * whole accessibility decision, and the six routes that resolve a descriptor
 * each made it (or, for rebuild/export, deliberately did not). The
 * control-plane modules that now contribute descriptors are
 * `defaultTenantState: "disabled"` (ADR-0022 §7), so the decision gained a
 * second axis — is the OWNING module enabled for this tenant? — and
 * `fetchGrantedPermissionKeys` does not remove a disabled module's permission
 * keys from a subject's set.
 *
 * A second axis decided per call site is how issue #841 happened (SSR admin
 * pages rendered data for modules whose API answered 403) and how PR #839's
 * `data_exchange` finding happened (the descriptor gate existed in six routes
 * and in nothing that the UI called). So the decision lives in ONE file,
 * `reporting/application/projection-access.ts`, and this test fails if any
 * other file reaches past it to the permission-only helper — which is what a
 * future call site would do by copying an older route.
 *
 * Text-scan based, with the same documented limitation as
 * `module-boundary.test.ts`: it matches real `import ... from "..."`
 * statements, so prose in a header comment that merely names the module does
 * not false-positive, and it cannot follow a re-export chain through a third
 * file (none exists today — verified by this test passing).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** The ONE file allowed to consume the permission-only helper (it is the file that adds the module axis on top of it). */
const CHOKEPOINT_FILE = path.join(
  "src",
  "modules",
  "reporting",
  "application",
  "projection-access.ts"
);

const PERMISSION_FILTER_MODULE = "projection-permission-filter";
const ACCESS_MODULE = "projection-access";

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (
      fullPath.endsWith(".ts") ||
      fullPath.endsWith(".tsx") ||
      fullPath.endsWith(".astro")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/** Matches a real import/export-from statement (or dynamic `import("...")`) naming `moduleName`, never a path merely mentioned in prose. */
function importsModule(source: string, moduleName: string): boolean {
  const pattern = new RegExp(
    `(from\\s*["'][^"']*${moduleName}["'])|(import\\(\\s*["'][^"']*${moduleName}["'])`
  );
  return pattern.test(source);
}

const SOURCE_FILES = listSourceFiles(SRC_ROOT).map((absolutePath) => ({
  relativePath: path.relative(REPO_ROOT, absolutePath),
  source: readFileSync(absolutePath, "utf8")
}));

describe("projection accessibility is decided in one place (Issue #880)", () => {
  test("only projection-access.ts imports the permission-only filter", () => {
    const offenders = SOURCE_FILES.filter(
      (file) =>
        file.relativePath !== CHOKEPOINT_FILE &&
        importsModule(file.source, PERMISSION_FILTER_MODULE)
    ).map((file) => file.relativePath);

    expect(
      offenders,
      `These files check a projection's permission WITHOUT checking whether the owning module is enabled for the tenant. Import from ${CHOKEPOINT_FILE} instead — a control-plane projection is default-disabled, and a permission key survives its module being switched off.`
    ).toEqual([]);
  });

  test("the chokepoint itself is wired (the gate is never vacuous)", () => {
    const chokepoint = SOURCE_FILES.find(
      (file) => file.relativePath === CHOKEPOINT_FILE
    );

    expect(chokepoint, `${CHOKEPOINT_FILE} must exist`).toBeDefined();
    expect(
      importsModule(chokepoint!.source, PERMISSION_FILTER_MODULE),
      "the chokepoint must still apply the permission check it wraps"
    ).toBe(true);
    expect(
      importsModule(
        chokepoint!.source,
        "identity-access/application/auth-context"
      ),
      "the chokepoint must resolve the owning module's tenant state"
    ).toBe(true);
  });

  test("every route that resolves a descriptor also applies the access gate", () => {
    const resolvers = SOURCE_FILES.filter(
      (file) =>
        file.relativePath.startsWith(path.join("src", "pages")) &&
        /findProjectionDescriptor/.test(file.source)
    );

    // Guards against the scan silently matching nothing (a rename would
    // otherwise turn this test into a no-op that always passes).
    expect(resolvers.length).toBeGreaterThanOrEqual(4);

    const ungated = resolvers
      .filter((file) => !importsModule(file.source, ACCESS_MODULE))
      .map((file) => file.relativePath);

    expect(
      ungated,
      `These routes resolve a ProjectionDescriptor but never check whether its owning module is enabled for the tenant (Issue #880). Add the ${ACCESS_MODULE} check after the coarse authorize call.`
    ).toEqual([]);
  });

  test("both unattended workers skip a projection whose owning module is disabled", () => {
    const workers = [
      path.join(
        "src",
        "modules",
        "reporting",
        "application",
        "projection-incremental-worker.ts"
      ),
      path.join(
        "src",
        "modules",
        "reporting",
        "application",
        "scheduled-export-dispatch.ts"
      )
    ];

    for (const worker of workers) {
      const file = SOURCE_FILES.find((f) => f.relativePath === worker);
      expect(file, `${worker} must exist`).toBeDefined();
      expect(
        importsModule(file!.source, ACCESS_MODULE),
        `${worker} must treat a module a tenant has not enabled as inert (ADR-0022 §7) — a disabled module must not have background work done on its behalf.`
      ).toBe(true);
    }
  });
});
