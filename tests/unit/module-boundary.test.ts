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
 * `import .../export ... from "..."` statements only (`from` immediately
 * followed by a quote character), which this repo's own header-comment
 * style never produces (comments backtick-quote paths, e.g. `` `news-
 * portal/domain/foo.ts` ``, never `from "..."` syntax) — so prose
 * mentioning the other module by name in a comment does not false-positive
 * here.
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

/** `forbiddenModuleDirName` — e.g. `"news-portal"` when scanning `blog-content`'s tree. Matches `from "...news-portal/application/..."` or `.../domain/...`, in single- or double-quoted import specifiers. */
function findForbiddenCrossModuleImports(
  rootDir: string,
  files: readonly string[],
  forbiddenModuleDirName: string
): string[] {
  const pattern = new RegExp(
    `from\\s+["'][^"']*${forbiddenModuleDirName}/(?:application|domain)/[^"']*["']`
  );
  const offenders: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      if (pattern.test(line)) {
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
