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
import { readdirSync, readFileSync, statSync } from "node:fs";
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
