/**
 * Structural boundary guard (Issue #681, epic #679 platform-hardening):
 * no `application`/`domain` file in `blog_content` may `import ... from`
 * `news_portal`'s `application`/`domain` tree, and no `application`/
 * `domain` file in `news_portal` may `import ... from` `blog_content`'s —
 * the exact acceptance criterion this issue exists for ("No application/
 * domain file in either module imports the other's implementation
 * directly"). Both modules previously had several such imports (see git
 * history / `.claude/skills/awcms-mini-news-portal/SKILL.md`'s §681
 * section) — now replaced by `_shared/ports/` capability interfaces,
 * injected by the caller (route handler = composition root). Importing a
 * TYPE from `_shared/ports/*.ts` is fine (that's the whole point of a
 * port); importing anything under the OTHER module's own `application`/
 * `domain` folders is exactly what this test exists to catch.
 *
 * Regex-based, same "scan source text for a forbidden pattern" convention
 * `news-portal-no-local-fallback.test.ts` already uses — matches real
 * `import .../export ... from "..."` statements (`from` immediately
 * followed by a quote character) AND dynamic `import("...")` calls, which
 * this repo's own header-comment style never produces (comments
 * backtick-quote paths, e.g. `` `news-portal/domain/foo.ts` ``, never
 * `from "..."`/`import("...")` syntax) — so prose mentioning the other
 * module by name in a comment does not false-positive here.
 *
 * Known limitation (reviewer + security-auditor, PR #702): this is a
 * CI/build-time text scan, not a real import-graph resolver — it cannot
 * catch a re-export CHAIN through a third file outside the two scanned
 * `application`/`domain` trees (e.g. an `infrastructure/` or `api/` file
 * that imports the other module and re-exports it, which an
 * `application`/`domain` file could then import without the forbidden
 * path ever appearing literally in a scanned file). No such chain exists
 * today (verified by this test passing); closing that residual gap for
 * good would need a real module-graph tool (`ts-morph`, an ESLint
 * `import/no-restricted-paths` rule with proper resolution, etc.), not a
 * text-pattern scan — left as a documented follow-up, not blocking.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
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

/** `forbiddenModuleDirName` — e.g. `"news-portal"` when scanning `blog-content`'s tree. `true` for a static `from "...news-portal/application/..."`/`.../domain/...` import/export line, OR a dynamic `import("...news-portal/application/...")` call — exported so the pattern itself can be unit-tested against synthetic lines, not just real files. */
export function lineViolatesModuleBoundary(
  line: string,
  forbiddenModuleDirName: string
): boolean {
  const staticImportPattern = new RegExp(
    `from\\s+["'][^"']*${forbiddenModuleDirName}/(?:application|domain)/[^"']*["']`
  );
  const dynamicImportPattern = new RegExp(
    `import\\s*\\(\\s*["'][^"']*${forbiddenModuleDirName}/(?:application|domain)/[^"']*["']`
  );

  return staticImportPattern.test(line) || dynamicImportPattern.test(line);
}

function findForbiddenCrossModuleImports(
  rootDir: string,
  files: readonly string[],
  forbiddenModuleDirName: string
): string[] {
  const offenders: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      if (lineViolatesModuleBoundary(line, forbiddenModuleDirName)) {
        offenders.push(
          `${path.relative(rootDir, file)}:${index + 1}: ${line.trim()}`
        );
      }
    });
  }

  return offenders;
}

const BLOG_CONTENT_APP_DOMAIN_DIRS = [
  path.join(import.meta.dir, "../../src/modules/blog-content/application"),
  path.join(import.meta.dir, "../../src/modules/blog-content/domain")
];

const NEWS_PORTAL_APP_DOMAIN_DIRS = [
  path.join(import.meta.dir, "../../src/modules/news-portal/application"),
  path.join(import.meta.dir, "../../src/modules/news-portal/domain")
];

describe("lineViolatesModuleBoundary (pattern correctness, PR #702 re-review)", () => {
  test("catches a static single-line import", () => {
    expect(
      lineViolatesModuleBoundary(
        'import { x } from "../../news-portal/application/foo";',
        "news-portal"
      )
    ).toBe(true);
  });

  test('catches the closing `} from "..."` line of a multi-line import', () => {
    expect(
      lineViolatesModuleBoundary(
        '} from "../../news-portal/domain/foo";',
        "news-portal"
      )
    ).toBe(true);
  });

  test("catches a dynamic import() call", () => {
    expect(
      lineViolatesModuleBoundary(
        'const mod = await import("../../news-portal/application/foo");',
        "news-portal"
      )
    ).toBe(true);
  });

  test("does not false-positive on a prose comment mentioning the other module by name", () => {
    expect(
      lineViolatesModuleBoundary(
        "// see news-portal/application/foo.ts for details",
        "news-portal"
      )
    ).toBe(false);
    expect(
      lineViolatesModuleBoundary(
        " * backtick-quoted path: `news-portal/domain/foo.ts`",
        "news-portal"
      )
    ).toBe(false);
  });

  test("does not flag an import from _shared/ports/ (the whole point of a port)", () => {
    expect(
      lineViolatesModuleBoundary(
        'import type { NewsMediaPort } from "../../_shared/ports/news-media-port";',
        "news-portal"
      )
    ).toBe(false);
  });
});

describe("module boundary — blog_content <-> news_portal (Issue #681)", () => {
  test("no blog_content application/domain file imports news_portal's application/domain implementation directly", () => {
    const files = BLOG_CONTENT_APP_DOMAIN_DIRS.flatMap(listTsFiles);
    expect(files.length).toBeGreaterThan(0);

    const offenders = BLOG_CONTENT_APP_DOMAIN_DIRS.flatMap((dir) =>
      findForbiddenCrossModuleImports(
        dir,
        files.filter((f) => f.startsWith(dir)),
        "news-portal"
      )
    );
    expect(offenders).toEqual([]);
  });

  test("no news_portal application/domain file imports blog_content's application/domain implementation directly", () => {
    const files = NEWS_PORTAL_APP_DOMAIN_DIRS.flatMap(listTsFiles);
    expect(files.length).toBeGreaterThan(0);

    const offenders = NEWS_PORTAL_APP_DOMAIN_DIRS.flatMap((dir) =>
      findForbiddenCrossModuleImports(
        dir,
        files.filter((f) => f.startsWith(dir)),
        "blog-content"
      )
    );
    expect(offenders).toEqual([]);
  });

  test("_shared/ports/ itself imports from neither module's application/domain tree (must stay neutral ground)", () => {
    const portsDir = path.join(
      import.meta.dir,
      "../../src/modules/_shared/ports"
    );
    const files = listTsFiles(portsDir);
    expect(files.length).toBeGreaterThan(0);

    const offendersA = findForbiddenCrossModuleImports(
      portsDir,
      files,
      "news-portal"
    );
    const offendersB = findForbiddenCrossModuleImports(
      portsDir,
      files,
      "blog-content"
    );
    expect([...offendersA, ...offendersB]).toEqual([]);
  });

  test("the shared gallery-block renderer imports from neither module's application/domain tree", () => {
    const renderingDir = path.join(
      import.meta.dir,
      "../../src/modules/_shared/rendering"
    );
    const files = listTsFiles(renderingDir);
    expect(files.length).toBeGreaterThan(0);

    const offendersA = findForbiddenCrossModuleImports(
      renderingDir,
      files,
      "news-portal"
    );
    const offendersB = findForbiddenCrossModuleImports(
      renderingDir,
      files,
      "blog-content"
    );
    expect([...offendersA, ...offendersB]).toEqual([]);
  });
});

/**
 * Control-plane <-> tenant-plane boundary (Issue #870, epic #868, ADR-0022
 * Consequences "Low, reviewer"). ADR-0022 requires the structural
 * no-shared-table-write / read-only-port boundary to LAND WITH the first
 * control-plane module rather than rely on manual review — this block is that
 * enforcement for `service_catalog`. It generalizes the blog_content <->
 * news_portal pattern above to the whole registry:
 *
 *   1. No OTHER module's application/domain imports `service-catalog`'s
 *      application/domain (base/core never reverse-depends on control-plane
 *      logic; a downstream consumer reads ONLY the `service_catalog_read`
 *      capability port, wired at ITS route/composition root — never a direct
 *      import of `service_catalog`'s internals).
 *   2. No module or route OUTSIDE `service_catalog` writes an
 *      `awcms_mini_service_catalog_*` table (ADR-0013 §6 no-shared-table-write
 *      — only the owning module mutates its tables).
 *   3. The `service_catalog_read` port file itself stays neutral ground (it
 *      imports no module's application/domain).
 *
 * The pattern is deliberately registry-wide so #871-#877 inherit it: each new
 * control-plane module just adds its own key/table-prefix to the arrays below.
 */
const MODULES_ROOT = path.join(import.meta.dir, "../../src/modules");
const PAGES_ROOT = path.join(import.meta.dir, "../../src/pages");

function moduleAppDomainDirs(moduleName: string): string[] {
  return ["application", "domain"]
    .map((sub) => path.join(MODULES_ROOT, moduleName, sub))
    .filter((dir) => existsSync(dir));
}

describe("module boundary — service_catalog control-plane <-> tenant-plane (Issue #870, ADR-0022)", () => {
  const CONTROL_PLANE_MODULE_DIR = "service-catalog";
  const CONTROL_PLANE_TABLE_PREFIX = "awcms_mini_service_catalog_";

  test("no OTHER module's application/domain imports service-catalog's application/domain (consume the read-only port instead)", () => {
    const offenders: string[] = [];

    for (const moduleName of readdirSync(MODULES_ROOT)) {
      if (moduleName === CONTROL_PLANE_MODULE_DIR || moduleName === "_shared") {
        continue;
      }
      const stat = statSync(path.join(MODULES_ROOT, moduleName));
      if (!stat.isDirectory()) {
        continue;
      }
      for (const dir of moduleAppDomainDirs(moduleName)) {
        offenders.push(
          ...findForbiddenCrossModuleImports(
            dir,
            listTsFiles(dir),
            CONTROL_PLANE_MODULE_DIR
          )
        );
      }
    }

    expect(
      offenders,
      "A tenant-plane / downstream module must read the catalog ONLY through the `service_catalog_read` capability port (`_shared/ports/service-catalog-read-port.ts`), wired at its own route/composition root — never by importing service_catalog's application/domain directly (ADR-0022 §4)."
    ).toEqual([]);
  });

  test("no module or route outside service_catalog writes an awcms_mini_service_catalog_ table (no-shared-table-write, ADR-0013 §6)", () => {
    const writePattern = new RegExp(
      `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${CONTROL_PLANE_TABLE_PREFIX}`,
      "i"
    );
    const offenders: string[] = [];

    function scan(root: string): void {
      for (const file of listTsFiles(root)) {
        // service_catalog's own module + route tree is the sole legitimate writer.
        if (
          file.includes(`/modules/${CONTROL_PLANE_MODULE_DIR}/`) ||
          file.includes(`/api/v1/${CONTROL_PLANE_MODULE_DIR}/`)
        ) {
          continue;
        }
        const content = readFileSync(file, "utf-8");
        content.split("\n").forEach((line, index) => {
          if (writePattern.test(line)) {
            offenders.push(
              `${path.relative(path.join(import.meta.dir, "../.."), file)}:${index + 1}: ${line.trim()}`
            );
          }
        });
      }
    }

    scan(MODULES_ROOT);
    scan(PAGES_ROOT);

    expect(
      offenders,
      "Only the service_catalog module (and its own routes) may write awcms_mini_service_catalog_* tables (ADR-0013 §6). A consumer reads published offers through the read-only port, never a direct write."
    ).toEqual([]);
  });

  test("the service_catalog_read port file imports no module's application/domain (neutral ground)", () => {
    const portFile = path.join(
      MODULES_ROOT,
      "_shared/ports/service-catalog-read-port.ts"
    );
    expect(existsSync(portFile)).toBe(true);

    const content = readFileSync(portFile, "utf-8");
    const lines = content.split("\n");
    // The port must not import ANY module's application/domain — scan for
    // every registered module dir name (mirrors the blog/news scan above).
    const moduleDirNames = readdirSync(MODULES_ROOT).filter((name) => {
      const full = path.join(MODULES_ROOT, name);
      return name !== "_shared" && statSync(full).isDirectory();
    });

    const offenders: string[] = [];
    lines.forEach((line, index) => {
      for (const moduleDir of moduleDirNames) {
        if (lineViolatesModuleBoundary(line, moduleDir)) {
          offenders.push(
            `service-catalog-read-port.ts:${index + 1}: ${line.trim()}`
          );
        }
      }
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * Control-plane <-> tenant-plane boundary for `tenant_entitlement` (Issue #871,
 * epic #868, ADR-0022 §4/Consequences). Same registry-wide enforcement as the
 * service_catalog block above — each new control-plane module adds its own key/
 * table-prefix/port here (the pattern was built to inherit):
 *
 *   1. No OTHER module's application/domain imports `tenant-entitlement`'s
 *      application/domain — a tenant-plane / downstream consumer reads ONLY the
 *      `effective_entitlement` capability port, wired at ITS route/composition
 *      root. (tenant_entitlement itself may consume `service_catalog_read` via
 *      the port TYPE + wire the adapter at its OWN route — which is not one of
 *      the scanned module app/domain trees.)
 *   2. No module or route OUTSIDE `tenant_entitlement` writes an
 *      `awcms_mini_tenant_entitlement_*` table (no-shared-table-write).
 *   3. The `effective_entitlement` port file stays neutral ground.
 */
describe("module boundary — tenant_entitlement control-plane <-> tenant-plane (Issue #871, ADR-0022)", () => {
  const CONTROL_PLANE_MODULE_DIR = "tenant-entitlement";
  const CONTROL_PLANE_TABLE_PREFIX = "awcms_mini_tenant_entitlement_";

  test("no OTHER module's application/domain imports tenant-entitlement's application/domain (consume the read-only port instead)", () => {
    const offenders: string[] = [];

    for (const moduleName of readdirSync(MODULES_ROOT)) {
      if (moduleName === CONTROL_PLANE_MODULE_DIR || moduleName === "_shared") {
        continue;
      }
      const stat = statSync(path.join(MODULES_ROOT, moduleName));
      if (!stat.isDirectory()) {
        continue;
      }
      for (const dir of moduleAppDomainDirs(moduleName)) {
        offenders.push(
          ...findForbiddenCrossModuleImports(
            dir,
            listTsFiles(dir),
            CONTROL_PLANE_MODULE_DIR
          )
        );
      }
    }

    expect(
      offenders,
      "A tenant-plane / downstream module must read entitlement ONLY through the `effective_entitlement` capability port (`_shared/ports/effective-entitlement-port.ts`), wired at its own route/composition root — never by importing tenant_entitlement's application/domain directly (ADR-0022 §4)."
    ).toEqual([]);
  });

  test("no module or route outside tenant_entitlement writes an awcms_mini_tenant_entitlement_ table (no-shared-table-write, ADR-0013 §6)", () => {
    const writePattern = new RegExp(
      `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${CONTROL_PLANE_TABLE_PREFIX}`,
      "i"
    );
    const offenders: string[] = [];

    function scan(root: string): void {
      for (const file of listTsFiles(root)) {
        if (
          file.includes(`/modules/${CONTROL_PLANE_MODULE_DIR}/`) ||
          file.includes(`/api/v1/${CONTROL_PLANE_MODULE_DIR}/`)
        ) {
          continue;
        }
        const content = readFileSync(file, "utf-8");
        content.split("\n").forEach((line, index) => {
          if (writePattern.test(line)) {
            offenders.push(
              `${path.relative(path.join(import.meta.dir, "../.."), file)}:${index + 1}: ${line.trim()}`
            );
          }
        });
      }
    }

    scan(MODULES_ROOT);
    scan(PAGES_ROOT);

    expect(
      offenders,
      "Only the tenant_entitlement module (and its own routes) may write awcms_mini_tenant_entitlement_* tables (ADR-0013 §6). A consumer reads the effective_entitlement port, never a direct write."
    ).toEqual([]);
  });

  test("the effective_entitlement port file imports no module's application/domain (neutral ground)", () => {
    const portFile = path.join(
      MODULES_ROOT,
      "_shared/ports/effective-entitlement-port.ts"
    );
    expect(existsSync(portFile)).toBe(true);

    const content = readFileSync(portFile, "utf-8");
    const lines = content.split("\n");
    const moduleDirNames = readdirSync(MODULES_ROOT).filter((name) => {
      const full = path.join(MODULES_ROOT, name);
      return name !== "_shared" && statSync(full).isDirectory();
    });

    const offenders: string[] = [];
    lines.forEach((line, index) => {
      for (const moduleDir of moduleDirNames) {
        if (lineViolatesModuleBoundary(line, moduleDir)) {
          offenders.push(
            `effective-entitlement-port.ts:${index + 1}: ${line.trim()}`
          );
        }
      }
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * Control-plane <-> tenant-plane boundary for `tenant_provisioning` (Issue #872,
 * epic #868, ADR-0022 §4). Same registry-wide enforcement as the
 * service_catalog / tenant_entitlement blocks above — each new control-plane
 * module adds its own key/prefix.
 *   1. No OTHER module's application/domain imports `tenant-provisioning`'s
 *      application/domain — a downstream module reads ONLY the read-only
 *      `provisioning_status` port at its own composition root. (The cross-module
 *      wiring `tenant_provisioning` itself needs — tenant_admin onboarding,
 *      tenant_entitlement assign/cancel — lives in its ROUTE composition root
 *      `_support.ts` under `src/pages/api/**`, which these gates deliberately do
 *      not scan, never inside its own application/domain.)
 *   2. No module or route OUTSIDE `tenant_provisioning` writes an
 *      `awcms_mini_tenant_provisioning_*` table (no-shared-table-write).
 *   3. The `provisioning_status` port file stays neutral ground.
 */
describe("module boundary — tenant_provisioning control-plane <-> tenant-plane (Issue #872, ADR-0022)", () => {
  const CONTROL_PLANE_MODULE_DIR = "tenant-provisioning";
  const CONTROL_PLANE_TABLE_PREFIX = "awcms_mini_tenant_provisioning_";

  test("no OTHER module's application/domain imports tenant-provisioning's application/domain (consume the read-only port instead)", () => {
    const offenders: string[] = [];

    for (const moduleName of readdirSync(MODULES_ROOT)) {
      if (moduleName === CONTROL_PLANE_MODULE_DIR || moduleName === "_shared") {
        continue;
      }
      const stat = statSync(path.join(MODULES_ROOT, moduleName));
      if (!stat.isDirectory()) {
        continue;
      }
      for (const dir of moduleAppDomainDirs(moduleName)) {
        offenders.push(
          ...findForbiddenCrossModuleImports(
            dir,
            listTsFiles(dir),
            CONTROL_PLANE_MODULE_DIR
          )
        );
      }
    }

    expect(
      offenders,
      "A tenant-plane / downstream module must read provisioning status ONLY through the `provisioning_status` capability port (`_shared/ports/provisioning-status-port.ts`), wired at its own route/composition root — never by importing tenant_provisioning's application/domain directly (ADR-0022 §4)."
    ).toEqual([]);
  });

  test("no module or route outside tenant_provisioning writes an awcms_mini_tenant_provisioning_ table (no-shared-table-write, ADR-0013 §6)", () => {
    const writePattern = new RegExp(
      `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${CONTROL_PLANE_TABLE_PREFIX}`,
      "i"
    );
    const offenders: string[] = [];

    function scan(root: string): void {
      for (const file of listTsFiles(root)) {
        if (
          file.includes(`/modules/${CONTROL_PLANE_MODULE_DIR}/`) ||
          file.includes(`/api/v1/${CONTROL_PLANE_MODULE_DIR}/`)
        ) {
          continue;
        }
        const content = readFileSync(file, "utf-8");
        content.split("\n").forEach((line, index) => {
          if (writePattern.test(line)) {
            offenders.push(
              `${path.relative(path.join(import.meta.dir, "../.."), file)}:${index + 1}: ${line.trim()}`
            );
          }
        });
      }
    }

    scan(MODULES_ROOT);
    scan(PAGES_ROOT);

    expect(
      offenders,
      "Only the tenant_provisioning module (and its own routes) may write awcms_mini_tenant_provisioning_* tables (ADR-0013 §6). A consumer reads the provisioning_status port, never a direct write."
    ).toEqual([]);
  });

  test("the provisioning_status port file imports no module's application/domain (neutral ground)", () => {
    const portFile = path.join(
      MODULES_ROOT,
      "_shared/ports/provisioning-status-port.ts"
    );
    expect(existsSync(portFile)).toBe(true);

    const content = readFileSync(portFile, "utf-8");
    const lines = content.split("\n");
    const moduleDirNames = readdirSync(MODULES_ROOT).filter((name) => {
      const full = path.join(MODULES_ROOT, name);
      return name !== "_shared" && statSync(full).isDirectory();
    });

    const offenders: string[] = [];
    lines.forEach((line, index) => {
      for (const moduleDir of moduleDirNames) {
        if (lineViolatesModuleBoundary(line, moduleDir)) {
          offenders.push(
            `provisioning-status-port.ts:${index + 1}: ${line.trim()}`
          );
        }
      }
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * Control-plane <-> tenant-plane boundary for `tenant_lifecycle` (Issue #873,
 * epic #868, ADR-0022 §4/§6). Same registry-wide enforcement as the blocks
 * above:
 *
 *   1. No OTHER module's application/domain imports `tenant-lifecycle`'s
 *      application/domain — a consumer reads ONLY the `tenant_restrictions` /
 *      `lifecycle_transition` capability ports, wired at ITS composition root.
 *      The base `identity_access` auth chokepoint ENFORCES lifecycle
 *      restrictions via the NEUTRAL-GROUND `_shared/tenant-lifecycle-policy.ts`
 *      + `_shared/tenant-lifecycle-restriction-read.ts` (a READ, no import of
 *      the control-plane module) — the whole reason those two files live in
 *      `_shared`, not under `tenant-lifecycle/`.
 *   2. No module or route OUTSIDE `tenant_lifecycle` writes an
 *      `awcms_mini_tenant_lifecycle_*` table (no-shared-table-write). The
 *      neutral reader/chokepoint only SELECTs.
 *   3. The lifecycle port + neutral policy/reader files stay neutral ground.
 */
describe("module boundary — tenant_lifecycle control-plane <-> tenant-plane (Issue #873, ADR-0022)", () => {
  const CONTROL_PLANE_MODULE_DIR = "tenant-lifecycle";
  const CONTROL_PLANE_TABLE_PREFIX = "awcms_mini_tenant_lifecycle_";

  test("no OTHER module's application/domain imports tenant-lifecycle's application/domain (consume the ports / neutral policy instead)", () => {
    const offenders: string[] = [];

    for (const moduleName of readdirSync(MODULES_ROOT)) {
      if (moduleName === CONTROL_PLANE_MODULE_DIR || moduleName === "_shared") {
        continue;
      }
      const stat = statSync(path.join(MODULES_ROOT, moduleName));
      if (!stat.isDirectory()) {
        continue;
      }
      for (const dir of moduleAppDomainDirs(moduleName)) {
        offenders.push(
          ...findForbiddenCrossModuleImports(
            dir,
            listTsFiles(dir),
            CONTROL_PLANE_MODULE_DIR
          )
        );
      }
    }

    expect(
      offenders,
      "A downstream module must consume lifecycle ONLY through the tenant_restrictions / lifecycle_transition ports (`_shared/ports/tenant-lifecycle-port.ts`) or the neutral policy/reader in `_shared` — never by importing tenant_lifecycle's application/domain directly (ADR-0022 §4)."
    ).toEqual([]);
  });

  test("no module or route outside tenant_lifecycle writes an awcms_mini_tenant_lifecycle_ table (no-shared-table-write, ADR-0013 §6)", () => {
    const writePattern = new RegExp(
      `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${CONTROL_PLANE_TABLE_PREFIX}`,
      "i"
    );
    const offenders: string[] = [];

    function scan(root: string): void {
      for (const file of listTsFiles(root)) {
        if (
          file.includes(`/modules/${CONTROL_PLANE_MODULE_DIR}/`) ||
          file.includes(`/api/v1/${CONTROL_PLANE_MODULE_DIR}/`)
        ) {
          continue;
        }
        const content = readFileSync(file, "utf-8");
        content.split("\n").forEach((line, index) => {
          if (writePattern.test(line)) {
            offenders.push(
              `${path.relative(path.join(import.meta.dir, "../.."), file)}:${index + 1}: ${line.trim()}`
            );
          }
        });
      }
    }

    scan(MODULES_ROOT);
    scan(PAGES_ROOT);

    expect(
      offenders,
      "Only the tenant_lifecycle module (and its own routes) may write awcms_mini_tenant_lifecycle_* tables (ADR-0013 §6). The auth chokepoint / neutral reader only SELECTs."
    ).toEqual([]);
  });

  test("the lifecycle port + neutral policy/reader files import no module's application/domain (neutral ground)", () => {
    const neutralFiles = [
      "_shared/ports/tenant-lifecycle-port.ts",
      "_shared/tenant-lifecycle-policy.ts",
      "_shared/tenant-lifecycle-restriction-read.ts"
    ];
    const moduleDirNames = readdirSync(MODULES_ROOT).filter((name) => {
      const full = path.join(MODULES_ROOT, name);
      return name !== "_shared" && statSync(full).isDirectory();
    });

    const offenders: string[] = [];
    for (const relative of neutralFiles) {
      const file = path.join(MODULES_ROOT, relative);
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        for (const moduleDir of moduleDirNames) {
          if (lineViolatesModuleBoundary(line, moduleDir)) {
            offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
