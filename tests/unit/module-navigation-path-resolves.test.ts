/**
 * Structural gate: every navigation entry a module declares must have a real
 * page behind it (Issue #878, epic #868).
 *
 * WHY THIS FILE EXISTS. `ModuleDescriptor.navigation` is trusted code-only
 * metadata that the sidebar renders directly (`module-management/domain/
 * navigation-registry.ts` -> `AdminLayout.astro`), filtered only by the
 * entry's `requiredPermission` and the module's tenant-enabled state. Nothing
 * ever checked that `path` resolves. `payment_gateway` shipped in #877 with a
 * declared entry for `/admin/payment-gateway` and no page at all: an operator
 * holding `payment_gateway.intents.read` on a tenant that HAD enabled the
 * module saw the link in their sidebar and got a 404 — the module's entire
 * read surface (provider health, account bindings, intent status) was
 * reachable only by calling the API by hand.
 *
 * That is invisible to every other gate in this repo: `modules:compose:check`
 * validates descriptor SHAPE, the nav-registry tests validate FILTERING, and
 * `bun run build` does not care that a string in a descriptor happens to look
 * like a route. Only an E2E that clicked every sidebar link would have caught
 * it, and none does.
 *
 * WHAT IT CHECKS. For each declared `path`, at least one Astro page file that
 * Astro's file-based router would serve for that exact URL must exist:
 * `src/pages/<path>.astro` or `src/pages/<path>/index.astro`.
 *
 * KNOWN LIMITATION (deliberate). This resolves STATIC paths only. A future
 * entry pointing at a dynamic route (`/admin/thing/[id]`) is not something a
 * sidebar link can meaningfully target anyway — every entry registered today
 * is static — so a dynamic segment in a declared nav path fails here on
 * purpose, as a prompt to reconsider rather than to loosen this check.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { listModules } from "../../src/modules";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PAGES_ROOT = path.join(REPO_ROOT, "src", "pages");

function candidatePagePaths(navPath: string): string[] {
  const relative = navPath.replace(/^\//, "");
  return [
    path.join(PAGES_ROOT, `${relative}.astro`),
    path.join(PAGES_ROOT, relative, "index.astro")
  ];
}

type Entry = {
  moduleKey: string;
  navPath: string;
  requiredPermission: string | undefined;
};

const ENTRIES: Entry[] = listModules().flatMap((module) =>
  (module.navigation ?? []).map((entry) => ({
    moduleKey: module.key,
    navPath: entry.path,
    requiredPermission: entry.requiredPermission
  }))
);

describe("module navigation paths resolve to real pages (Issue #878)", () => {
  test("the registry actually declares navigation entries (the gate is never vacuous)", () => {
    // A refactor that moved `navigation` elsewhere would otherwise leave this
    // file passing while checking nothing at all.
    expect(ENTRIES.length).toBeGreaterThan(10);
  });

  test("every declared navigation path has a page behind it", () => {
    const broken = ENTRIES.filter(
      (entry) =>
        !candidatePagePaths(entry.navPath).some((candidate) =>
          existsSync(candidate)
        )
    ).map(
      (entry) =>
        `${entry.moduleKey} -> ${entry.navPath} (requiredPermission: ${entry.requiredPermission ?? "none"})`
    );

    expect(
      broken,
      "These modules render a sidebar link to a page that does not exist — a permitted operator clicking it gets a 404. Either build the page or remove the navigation entry from the module descriptor."
    ).toEqual([]);
  });

  test("every declared navigation path is static and admin-scoped", () => {
    for (const entry of ENTRIES) {
      expect(
        entry.navPath.startsWith("/admin/"),
        `${entry.moduleKey} declares a navigation path outside /admin/ (${entry.navPath}) — the sidebar this feeds is the admin sidebar.`
      ).toBe(true);
      expect(
        /[[\]]/.test(entry.navPath),
        `${entry.moduleKey} declares a dynamic navigation path (${entry.navPath}); a sidebar link cannot fill a route parameter.`
      ).toBe(false);
    }
  });
});
