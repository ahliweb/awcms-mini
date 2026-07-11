/**
 * Tests for `scripts/i18n-extract.ts` (Issue #694, epic #679
 * platform-hardening — "generate messages.pot and enforce EN/ID/POT key
 * parity"). Proves extraction is deterministic, finds every call-site
 * shape this codebase actually uses (including the indirect
 * `labelKey`/`ERROR_CODE_KEYS` patterns that a naive literal-string scan
 * would miss and wrongly flag as "obsolete"), and rejects unrecognized
 * dynamic template-literal prefixes instead of silently under-extracting.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertNoDeadDynamicFamilies,
  buildPotContent,
  DYNAMIC_KEY_FAMILIES,
  ERROR_CODE_KEYS_FILE,
  extractKeys,
  type ExtractedEntry
} from "../../scripts/i18n-extract";
import { parsePo } from "../../src/lib/i18n/po-parser";

async function withFixtureTree(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "awcms-i18n-extract-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(dir, relPath);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("extractKeys — literal call sites", () => {
  test('finds a simple single-line t("key") call', async () => {
    await withFixtureTree(
      {
        "src/pages/example.astro": `<p>{t("example.greeting")}</p>`
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.has("example.greeting")).toBe(true);
        expect(entries.get("example.greeting")!.file).toBe(
          "src/pages/example.astro"
        );
      }
    );
  });

  test('finds a Prettier-wrapped multi-line t(\n  "key"\n) call', async () => {
    await withFixtureTree(
      {
        "src/pages/example.astro": [
          "<p>",
          "  {t(",
          '    "example.wrapped_key"',
          "  )}",
          "</p>"
        ].join("\n")
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.has("example.wrapped_key")).toBe(true);
        // Line of the `t(` call itself (line 2, `  {t(`), not the wrapped
        // string literal's own line (line 3) — matches where match.index
        // points (the start of the whole `t(...)` match).
        expect(entries.get("example.wrapped_key")!.line).toBe(2);
      }
    );
  });

  test("finds both single- and double-quoted calls, and records the correct line number", async () => {
    await withFixtureTree(
      {
        "src/lib/example.ts": [
          "const a = t('example.single');",
          'const b = t("example.double");'
        ].join("\n")
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.get("example.single")!.line).toBe(1);
        expect(entries.get("example.double")!.line).toBe(2);
      }
    );
  });

  test("ignores unrelated identifiers ending in 't(' (e.g. format(), let-bound expressions)", async () => {
    await withFixtureTree(
      {
        "src/lib/example.ts": [
          'const x = format("not.a.key");',
          "let(",
          '  "also.not.a.key"',
          ");"
        ].join("\n")
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.has("not.a.key")).toBe(false);
        expect(entries.has("also.not.a.key")).toBe(false);
      }
    );
  });

  test("does not scan .test.ts files", async () => {
    await withFixtureTree(
      {
        "src/lib/example.test.ts": 't("should.not.be.found");'
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.has("should.not.be.found")).toBe(false);
      }
    );
  });
});

describe("extractKeys — indirect key sources (dynamic-key false-positive guard)", () => {
  test("a labelKey literal is extracted even though it's only ever passed to t() via a variable (t(entry.labelKey))", async () => {
    await withFixtureTree(
      {
        "src/modules/example/module.ts": [
          "export const exampleModule = {",
          "  navigation: [",
          '    { labelKey: "admin.layout.nav_example", path: "/admin/example" }',
          "  ]",
          "};"
        ].join("\n"),
        "src/layouts/AdminLayout.astro": "<a>{t(entry.labelKey)}</a>"
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        // Found via the labelKey definition site, NOT the opaque
        // t(entry.labelKey) call site (which a literal-string scan can
        // never resolve) — proves this key would NOT be wrongly reported
        // as an obsolete/unused candidate.
        expect(entries.has("admin.layout.nav_example")).toBe(true);
        expect(entries.get("admin.layout.nav_example")!.file).toBe(
          "src/modules/example/module.ts"
        );
      }
    );
  });

  test("an ERROR_CODE_KEYS map value is extracted even though it's only ever passed to t() via a variable (t(key))", async () => {
    await withFixtureTree(
      {
        [ERROR_CODE_KEYS_FILE]: [
          "export const ERROR_CODE_KEYS: Record<string, string> = {",
          '  EXAMPLE_CODE: "error.example_code"',
          "};",
          "",
          "export function translateErrorCode(t, code, fallback) {",
          "  const key = ERROR_CODE_KEYS[code];",
          "  return key ? t(key) : fallback;",
          "}"
        ].join("\n")
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.has("error.example_code")).toBe(true);
      }
    );
  });

  test("does not scan unrelated Record<string,string> maps for ERROR_CODE_KEYS-shaped values", async () => {
    await withFixtureTree(
      {
        "src/lib/example.ts": [
          "const MIME_TYPE_TO_EXTENSION: Record<string, string> = {",
          '  "image/jpeg": "jpg"',
          "};"
        ].join("\n")
      },
      async (dir) => {
        const { entries } = await extractKeys(dir);
        expect(entries.has("jpg")).toBe(false);
        expect(entries.has("image/jpeg")).toBe(false);
      }
    );
  });
});

describe("extractKeys — dynamic key families (t(`prefix.${var}`))", () => {
  test("resolves a known family to its full concrete suffix set from a single call site", async () => {
    const family = DYNAMIC_KEY_FAMILIES.find(
      (f) => f.prefix === "admin.blog.status."
    )!;

    await withFixtureTree(
      {
        "src/pages/admin/blog/index.astro":
          "<span>{t(`admin.blog.status.${post.status}`)}</span>"
      },
      async (dir) => {
        const { entries, dynamicPrefixesSeen } = await extractKeys(dir);
        for (const suffix of family.suffixes) {
          expect(entries.has(`admin.blog.status.${suffix}`)).toBe(true);
        }
        expect(dynamicPrefixesSeen.has("admin.blog.status.")).toBe(true);
      }
    );
  });

  test("throws when a t(`prefix.${var}`) call's prefix has no DYNAMIC_KEY_FAMILIES entry", async () => {
    await withFixtureTree(
      {
        "src/pages/example.astro":
          "<span>{t(`some.totally.unregistered.${value}`)}</span>"
      },
      async (dir) => {
        await expect(extractKeys(dir)).rejects.toBeInstanceOf(Error);
      }
    );
  });
});

describe("assertNoDeadDynamicFamilies", () => {
  test("passes when every real DYNAMIC_KEY_FAMILIES prefix was seen", () => {
    const allPrefixes = new Set(DYNAMIC_KEY_FAMILIES.map((f) => f.prefix));
    expect(() => assertNoDeadDynamicFamilies(allPrefixes)).not.toThrow();
  });

  test("throws when a declared family prefix was never matched by any call site (dead table entry)", () => {
    // Simulates a fixture/scan that never referenced any real dynamic
    // family — e.g. a src/ tree with only literal t("...") calls. This is
    // the scenario tests/unit/i18n-extract.test.ts's own fixtures hit
    // constantly, which is exactly why this assertion lives OUTSIDE
    // extractKeys() and must be invoked explicitly.
    expect(() => assertNoDeadDynamicFamilies(new Set())).toThrow();
  });

  test("throws naming the specific unreferenced prefix", () => {
    const allButOne = new Set(
      DYNAMIC_KEY_FAMILIES.slice(1).map((f) => f.prefix)
    );
    const escapedPrefix = DYNAMIC_KEY_FAMILIES[0]!.prefix.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    expect(() => assertNoDeadDynamicFamilies(allButOne)).toThrow(
      new RegExp(escapedPrefix)
    );
  });
});

describe("extractKeys — determinism", () => {
  test("scanning the same fixture tree twice yields byte-identical rendered POT content", async () => {
    await withFixtureTree(
      {
        "src/pages/z-page.astro":
          '<p>{t("zebra.key")}</p><p>{t("apple.key")}</p>',
        "src/pages/a-page.astro": '<p>{t("mango.key")}</p>',
        "src/components/widget.astro": '<p>{t("apple.key")}</p>'
      },
      async (dir) => {
        const first = buildPotContent((await extractKeys(dir)).entries);
        const second = buildPotContent((await extractKeys(dir)).entries);
        expect(second).toBe(first);
      }
    );
  });

  test("buildPotContent's key order is alphabetical, independent of Map insertion order", () => {
    const inOrderA = new Map<string, ExtractedEntry>([
      ["zebra.key", { key: "zebra.key", file: "a.ts", line: 1 }],
      ["apple.key", { key: "apple.key", file: "a.ts", line: 2 }],
      ["mango.key", { key: "mango.key", file: "a.ts", line: 3 }]
    ]);
    const inOrderB = new Map<string, ExtractedEntry>([
      ["apple.key", { key: "apple.key", file: "a.ts", line: 2 }],
      ["mango.key", { key: "mango.key", file: "a.ts", line: 3 }],
      ["zebra.key", { key: "zebra.key", file: "a.ts", line: 1 }]
    ]);

    expect(buildPotContent(inOrderA)).toBe(buildPotContent(inOrderB));

    const rendered = buildPotContent(inOrderA);
    const appleIndex = rendered.indexOf('msgid "apple.key"');
    const mangoIndex = rendered.indexOf('msgid "mango.key"');
    const zebraIndex = rendered.indexOf('msgid "zebra.key"');
    expect(appleIndex).toBeLessThan(mangoIndex);
    expect(mangoIndex).toBeLessThan(zebraIndex);
  });

  test("buildPotContent renders a fixed header, then one msgid/msgstr block per key", () => {
    const entries = new Map<string, ExtractedEntry>([
      ["only.key", { key: "only.key", file: "src/example.ts", line: 7 }]
    ]);

    const rendered = buildPotContent(entries);

    expect(rendered).toContain('"Content-Type: text/plain; charset=UTF-8\\n"');
    expect(rendered).toContain("#: src/example.ts:7");
    expect(rendered).toContain('msgid "only.key"');
    expect(rendered).toContain('msgstr ""');
  });
});

describe("extractKeys — spot-check against the real repository source tree", () => {
  test('finds real, known t("...") call sites from actual admin pages', async () => {
    const { entries } = await extractKeys(process.cwd());

    // Stable, unlikely-to-churn literal keys from real pages.
    expect(entries.has("auth.login.submit")).toBe(true);
    expect(entries.has("common.retry")).toBe(true);
  });

  test("finds real indirect labelKey and ERROR_CODE_KEYS keys from the actual repo", async () => {
    const { entries } = await extractKeys(process.cwd());

    expect(entries.has("admin.layout.nav_blog")).toBe(true);
    expect(entries.has("error.access_denied")).toBe(true);
  });

  test("resolves real dynamic key families from the actual repo (admin.blog.status.*)", async () => {
    const { entries } = await extractKeys(process.cwd());

    expect(entries.has("admin.blog.status.draft")).toBe(true);
    expect(entries.has("admin.blog.status.published")).toBe(true);
  });

  test("every real DYNAMIC_KEY_FAMILIES entry is actually referenced somewhere in src/ (no dead table entries)", async () => {
    const { dynamicPrefixesSeen } = await extractKeys(process.cwd());

    expect(() =>
      assertNoDeadDynamicFamilies(dynamicPrefixesSeen)
    ).not.toThrow();
  });

  test("the real repository's extracted key set exactly matches i18n/en.po's key set (no missing, no obsolete)", async () => {
    const enSource = await readFile(
      path.join(process.cwd(), "i18n/en.po"),
      "utf8"
    );
    const enKeys = new Set(Object.keys(parsePo(enSource)));
    const { entries } = await extractKeys(process.cwd());
    const extractedKeys = new Set(entries.keys());

    const missingFromExtraction = [...enKeys].filter(
      (k) => !extractedKeys.has(k)
    );
    const notInEnPo = [...extractedKeys].filter((k) => !enKeys.has(k));

    expect(missingFromExtraction).toEqual([]);
    expect(notInEnPo).toEqual([]);
  });
});
