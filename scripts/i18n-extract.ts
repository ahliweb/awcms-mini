/**
 * Deterministic source-code extraction for `i18n/messages.pot` (Issue #694,
 * epic #679 platform-hardening — "generate messages.pot and enforce
 * EN/ID/POT key parity").
 *
 * Before this issue, `messages.pot` was maintained BY HAND (no extraction
 * tooling existed at all) — Issue #685 fixed the symptom (its 623-vs-827
 * key drift against `en.po`/`id.po`) by hand-editing the template back
 * into sync, but nothing prevented the same drift from recurring the next
 * time a contributor added a `t("...")` call and forgot to also touch
 * `messages.pot`. This script is the actual fix: it scans `src/` for every
 * `t(...)` call site (and the handful of *indirect* key references this
 * codebase has — see "Indirect key sources" below) and regenerates
 * `messages.pot` from what the code actually references, not from
 * whatever a human last remembered to copy over.
 *
 * ## Usage
 *
 * - `bun run i18n:extract` — rewrites `i18n/messages.pot` in place. Run
 *   this after adding/removing any `t("...")` call, then fill in the new
 *   key's `msgstr` in `i18n/en.po`/`i18n/id.po` by hand (translation is
 *   still a human task; only the template's key inventory is automated).
 * - `scripts/i18n-pot-check.ts` (`bun run i18n:pot:check`, part of
 *   `bun run check`) is the READ-ONLY twin: it regenerates the template
 *   in memory and fails the build if that differs from the committed
 *   `messages.pot` — the same generate-to-temp-and-diff pattern
 *   `scripts/check-docs.mjs`/`scripts/config-docs-check.ts` already use
 *   for other doc/config drift gates.
 *
 * ## Determinism
 *
 * Two runs against the same `src/` tree byte-for-byte match:
 * - `walkSourceFiles` sorts directory entries alphabetically at every
 *   level before recursing (`readdir`'s own order is filesystem-dependent
 *   and NOT guaranteed stable — this repo's other tree-walkers, e.g.
 *   `scripts/api-spec-check.ts`'s `walkRouteFiles`, don't need this
 *   because they only ever aggregate into `Set`s; this script emits an
 *   ordered file, so file-visit order must itself be pinned).
 * - The emitted `.pot`'s key ORDER is a final alphabetical sort over the
 *   discovered key set (`buildPotContent`) — independent of scan order
 *   entirely, so even a change to `walkSourceFiles`'s traversal strategy
 *   could never change the output for a fixed key set.
 * - Each key's `#:` source-location comment records the FIRST occurrence
 *   in that same sorted file order — also pinned, not "whichever file the
 *   OS handed back first".
 *
 * ## Literal call-site extraction
 *
 * Matches `t(` (word-boundary — so this doesn't also match `format(`,
 * `let(`, etc., and doesn't require the call to be the top-level
 * expression) followed by a quoted string as the first argument:
 * `t("key")`, `t('key')`, `` t(`key`) ``, including the multi-line-wrapped
 * form Prettier produces for long keys (`t(\n  "key"\n)`). A `` ` ``
 * -quoted argument containing `${` (template-literal interpolation) is
 * NOT a literal key — see "Dynamic key families" below.
 *
 * ## Indirect key sources (this codebase's actual dynamic-key patterns)
 *
 * A purely literal-string scan misses two real patterns already in this
 * codebase, where the msgid is a literal string, but not passed directly
 * to `t(...)` — it's read from a named property at the call site instead:
 *
 * 1. **`labelKey: "admin.layout.nav_x"`** — every module's nav entry
 *    (`src/modules/*\/module.ts`) declares its label key as a literal-
 *    valued property, then `AdminLayout.astro`/
 *    `admin/modules/[moduleKey].astro` call `t(entry.labelKey)` — the
 *    variable, not a literal, is what reaches `t(...)`. `LABEL_KEY_RE`
 *    below picks up the literal definition site instead (a more useful
 *    translator-comment location anyway: "this is the module that owns
 *    this label", not "this is the shell that renders whatever label it's
 *    handed").
 * 2. **`ERROR_CODE_KEYS`** (`src/lib/i18n/error-messages.ts`) — the
 *    `{ ERROR_CODE: "error.snake_case" }` map `translateErrorCode`/
 *    `buildClientErrorMessages` look up dynamically (`t(key)` where `key`
 *    comes from the map, never a literal at the call site).
 *
 * Both are scanned for explicitly (`LABEL_KEY_RE`, `ERROR_CODE_VALUE_RE`)
 * rather than treated as unavoidable extraction blind spots — the
 * alternative (only literal-scanning `t(...)`) would make EVERY key
 * referenced this way look "obsolete" (never found by extraction) even
 * though it's very much alive, exactly the false-positive risk Issue #694
 * warns against.
 *
 * ## Dynamic key families (template-literal interpolation)
 *
 * A third pattern this codebase uses — `t(\`admin.blog.status.${status}\`)`
 * — is NOT resolvable by reading the call site at all: the concrete
 * suffix only exists at runtime. `DYNAMIC_KEY_FAMILIES` below is an
 * explicit, reviewed table (same spirit as
 * `src/lib/config/registry.ts`'s `CONFIG_EXEMPTIONS`, Issue #689) mapping
 * each such prefix to its full concrete suffix set, copied from that
 * value's actual domain source of truth (a `readonly X[]` const, or the
 * DB CHECK constraint where no such const exists) — see each entry's
 * `source` field. `extractKeys()` throws if source code contains a
 * `t(\`prefix.${...}\`)` call whose prefix has no table entry (a new
 * dynamic family must be added here, not silently dropped), and equally
 * throws if a table entry is no longer referenced by any call site (dead
 * entry — remove it or fix the call site) — the table can't silently
 * drift from the code in either direction.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parsePo } from "../src/lib/i18n/po-parser";

export const SRC_ROOT = "src";
export const POT_PATH = "i18n/messages.pot";
export const ERROR_CODE_KEYS_FILE = "src/lib/i18n/error-messages.ts";

const SCANNABLE_EXTENSIONS = [".astro", ".ts", ".tsx"];

export type DynamicKeyFamily = {
  prefix: string;
  suffixes: readonly string[];
  source: string;
};

/** See file header §Dynamic key families. */
export const DYNAMIC_KEY_FAMILIES: readonly DynamicKeyFamily[] = [
  {
    prefix: "admin.blog.status.",
    suffixes: ["draft", "review", "scheduled", "published", "archived"],
    source:
      "src/modules/blog-content/domain/post-status.ts BLOG_CONTENT_STATUSES"
  },
  {
    prefix: "admin.blog.visibility.",
    suffixes: ["public", "private", "unlisted"],
    source:
      "src/modules/blog-content/domain/post-status.ts BLOG_CONTENT_VISIBILITIES"
  },
  {
    prefix: "admin.blog.page_type.",
    suffixes: ["standard", "landing", "legal", "system"],
    source: "src/modules/blog-content/domain/page-type.ts PAGE_TYPES"
  },
  {
    prefix: "admin.blog.widgets.position_",
    suffixes: [
      "header",
      "sidebar",
      "footer",
      "content_before",
      "content_after"
    ],
    source: "src/modules/blog-content/domain/widget-policy.ts WIDGET_POSITIONS"
  },
  {
    prefix: "admin.blog.settings.theme_mode_",
    suffixes: ["light", "dark", "system"],
    source: "src/modules/blog-content/domain/theme-policy.ts BLOG_THEME_MODES"
  },
  {
    prefix: "admin.blog.templates.sidebar_",
    suffixes: ["left", "right", "none"],
    source:
      'src/pages/admin/blog/templates.astro inline ["left","right","none"] option list (no exported domain constant — sidebarPosition layout field, not persisted as its own enum type)'
  },
  {
    prefix: "admin.tenant_domain.domain_type.",
    suffixes: ["subdomain", "custom_domain"],
    source:
      "src/modules/tenant-domain/domain/tenant-domain-validation.ts TENANT_DOMAIN_TYPES"
  },
  {
    prefix: "admin.tenant_domain.route_mode.",
    suffixes: ["canonical", "legacy_blog"],
    source:
      "src/modules/tenant-domain/domain/tenant-domain-validation.ts TENANT_DOMAIN_ROUTE_MODES"
  },
  {
    prefix: "admin.tenant_domain.verification_method.",
    suffixes: ["dns_txt", "dns_cname", "file", "manual"],
    source:
      "src/modules/tenant-domain/domain/tenant-domain-validation.ts TENANT_DOMAIN_VERIFICATION_METHODS"
  },
  {
    prefix: "admin.tenant_domain.status.",
    // Full status vocabulary, not just `TENANT_DOMAIN_UPDATABLE_STATUSES`
    // (that array deliberately excludes "active" — a domain only reaches
    // "active" via POST .../verify, never a generic PATCH — but
    // `domains.astro` still *displays* the "active" status for already-
    // verified domains via this same `t(\`...status.${domain.status}\`)`
    // call, so "active" is a real, live suffix too).
    suffixes: ["pending_verification", "active", "suspended", "failed"],
    source:
      "sql/031_awcms_mini_tenant_domain_schema.sql CHECK (status IN ('pending_verification','active','suspended','failed')); src/modules/tenant-domain/domain/tenant-domain-validation.ts TENANT_DOMAIN_UPDATABLE_STATUSES covers all but 'active'"
  }
];

export type ExtractedEntry = {
  key: string;
  file: string;
  line: number;
  note?: string;
};

const T_CALL_RE = /\bt\(\s*(["'`])([\s\S]*?)\1/g;
const LABEL_KEY_RE = /\blabelKey:\s*(["'])([\w.]+)\1/g;
const ERROR_CODE_VALUE_RE = /:\s*"(error\.[\w.]+)"/g;
const PLAUSIBLE_KEY_RE = /^[a-zA-Z0-9_.]+$/;

function buildLineIndex(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineNumberAt(lineStarts: readonly number[], index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let result = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= index) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result + 1;
}

async function walkSourceFiles(dir: string): Promise<string[]> {
  let dirEntries;

  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sorted = [...dirEntries].sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];

  for (const entry of sorted) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(full)));
      continue;
    }

    const isScannable = SCANNABLE_EXTENSIONS.some((ext) =>
      entry.name.endsWith(ext)
    );
    const isTestFile =
      entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");

    if (isScannable && !isTestFile) {
      files.push(full);
    }
  }

  return files;
}

export type ExtractResult = {
  entries: Map<string, ExtractedEntry>;
  /** Every `DYNAMIC_KEY_FAMILIES` prefix actually matched during this scan — see `assertNoDeadDynamicFamilies`. */
  dynamicPrefixesSeen: ReadonlySet<string>;
};

/**
 * Scans `<rootDir>/src` and returns every live i18n key this source tree
 * references, each with the location of its first (sorted-order)
 * occurrence. Throws on an unrecognized dynamic-prefix call site (a
 * `t(\`prefix.${...}\`)` whose prefix has no `DYNAMIC_KEY_FAMILIES` entry)
 * — see file header. Does NOT check whether every `DYNAMIC_KEY_FAMILIES`
 * entry was referenced; that's `assertNoDeadDynamicFamilies`'s job,
 * deliberately kept out of this function (see its docstring) so this
 * stays usable against small synthetic fixture trees in unit tests.
 */
export async function extractKeys(
  rootDir = process.cwd()
): Promise<ExtractResult> {
  const files = await walkSourceFiles(path.join(rootDir, SRC_ROOT));
  const entries = new Map<string, ExtractedEntry>();
  const dynamicPrefixesSeen = new Set<string>();

  const record = (
    key: string,
    file: string,
    line: number,
    note?: string
  ): void => {
    if (!entries.has(key)) {
      entries.set(key, { key, file, line, note });
    }
  };

  for (const absFile of files) {
    const relFile = path.relative(rootDir, absFile).split(path.sep).join("/");
    const content = await readFile(absFile, "utf8");
    const lineStarts = buildLineIndex(content);

    for (const match of content.matchAll(T_CALL_RE)) {
      const quote = match[1]!;
      const raw = match[2]!;
      const line = lineNumberAt(lineStarts, match.index ?? 0);

      if (quote === "`" && raw.includes("${")) {
        const prefix = raw.slice(0, raw.indexOf("${"));
        const family = DYNAMIC_KEY_FAMILIES.find((f) => f.prefix === prefix);

        if (!family) {
          throw new Error(
            `i18n-extract: ${relFile}:${line} calls t(\`${raw}\`) whose static prefix "${prefix}" has no matching entry in DYNAMIC_KEY_FAMILIES (scripts/i18n-extract.ts). Add one with its concrete suffix values, or change the call site to a literal key.`
          );
        }

        dynamicPrefixesSeen.add(prefix);

        for (const suffix of family.suffixes) {
          record(
            `${prefix}${suffix}`,
            relFile,
            line,
            `dynamic key family "${prefix}" — concrete suffix from ${family.source} (see DYNAMIC_KEY_FAMILIES, scripts/i18n-extract.ts)`
          );
        }

        continue;
      }

      if (!PLAUSIBLE_KEY_RE.test(raw)) {
        // Not a dotted-key-shaped literal (e.g. a `t(...)`-shaped fragment
        // inside a comment or an unrelated SQL string) — skip rather than
        // emit a garbage msgid.
        continue;
      }

      record(raw, relFile, line);
    }

    for (const match of content.matchAll(LABEL_KEY_RE)) {
      const key = match[2]!;
      const line = lineNumberAt(lineStarts, match.index ?? 0);
      record(
        key,
        relFile,
        line,
        "referenced dynamically via t(entry.labelKey) (AdminLayout.astro / admin/modules/[moduleKey].astro)"
      );
    }

    if (relFile === ERROR_CODE_KEYS_FILE) {
      for (const match of content.matchAll(ERROR_CODE_VALUE_RE)) {
        const key = match[1]!;
        const line = lineNumberAt(lineStarts, match.index ?? 0);
        record(
          key,
          relFile,
          line,
          "referenced dynamically via ERROR_CODE_KEYS (translateErrorCode / buildClientErrorMessages)"
        );
      }
    }
  }

  return { entries, dynamicPrefixesSeen };
}

/**
 * Fails loudly if a `DYNAMIC_KEY_FAMILIES` table entry (scripts/
 * i18n-extract.ts) was declared but never actually matched by a
 * `t(\`prefix.${...}\`)` call site in the scanned tree — a sign the table
 * has drifted from the code (the call site was refactored to a literal,
 * removed, or renamed) and the entry is now dead weight that could hide a
 * future real drift.
 *
 * Deliberately a SEPARATE function from `extractKeys()`, not folded into
 * it: `extractKeys()` is also used by unit tests against small synthetic
 * fixture trees that only exercise one or two call-site shapes at a time
 * (see tests/unit/i18n-extract.test.ts) — folding an "every one of the 10
 * real production families must be referenced" assertion into the
 * general-purpose scan function would make it impossible to unit-test any
 * fixture that doesn't happen to reproduce the entire real `src/` tree.
 * Only the real full-tree scanners (`bun run i18n:extract`'s CLI entry
 * point, `scripts/i18n-pot-check.ts`) call this, after a real scan of the
 * actual `src/` directory — where "every declared family is referenced"
 * is a meaningful invariant to enforce.
 */
export function assertNoDeadDynamicFamilies(
  dynamicPrefixesSeen: ReadonlySet<string>
): void {
  for (const family of DYNAMIC_KEY_FAMILIES) {
    if (!dynamicPrefixesSeen.has(family.prefix)) {
      throw new Error(
        `i18n-extract: DYNAMIC_KEY_FAMILIES entry "${family.prefix}" (scripts/i18n-extract.ts) was not matched by any t(\`...\`) call site under src/ — remove the stale entry or fix the call site it was meant to cover.`
      );
    }
  }
}

function escapePoString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

const POT_HEADER = [
  'msgid ""',
  'msgstr ""',
  '"Project-Id-Version: awcms-mini\\n"',
  '"Report-Msgid-Bugs-To: \\n"',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  '"Content-Transfer-Encoding: 8bit\\n"'
].join("\n");

/**
 * Renders the final `.pot` file content: fixed header + one block per key,
 * sorted alphabetically (the only ordering this function reads from
 * `entries` is the key set itself — insertion order into the `Map` never
 * affects output, which is what makes this stable across any change to
 * scan/traversal order).
 */
export function buildPotContent(entries: Map<string, ExtractedEntry>): string {
  const sortedKeys = [...entries.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  const blocks = sortedKeys.map((key) => {
    const entry = entries.get(key)!;
    const lines: string[] = [];

    if (entry.note) {
      lines.push(`#. ${entry.note}`);
    }

    lines.push(`#: ${entry.file}:${entry.line}`);
    lines.push(`msgid "${escapePoString(key)}"`);
    lines.push('msgstr ""');

    return lines.join("\n");
  });

  return `${POT_HEADER}\n\n${blocks.join("\n\n")}\n\n`;
}

if (import.meta.main) {
  const rootDir = process.cwd();
  const { entries, dynamicPrefixesSeen } = await extractKeys(rootDir);

  assertNoDeadDynamicFamilies(dynamicPrefixesSeen);

  const content = buildPotContent(entries);

  await writeFile(path.join(rootDir, POT_PATH), content, "utf8");

  console.log(`i18n:extract — wrote ${entries.size} keys to ${POT_PATH}.`);

  const enSource = await readFile(
    path.join(rootDir, "i18n/en.po"),
    "utf8"
  ).catch(() => "");
  const enKeys = new Set(Object.keys(parsePo(enSource)));
  const extractedKeys = new Set(entries.keys());

  const obsoleteCandidates = [...enKeys]
    .filter((key) => !extractedKeys.has(key))
    .sort();
  const newlyDiscovered = [...extractedKeys]
    .filter((key) => !enKeys.has(key))
    .sort();

  if (obsoleteCandidates.length > 0) {
    console.warn(
      `\ni18n:extract — ${obsoleteCandidates.length} key(s) in i18n/en.po were NOT found by extraction (obsolete candidates — the code that used to call t() with these keys appears to be gone). Before deleting them from en.po/id.po/messages.pot, confirm they aren't referenced dynamically (check DYNAMIC_KEY_FAMILIES / labelKey / ERROR_CODE_KEYS in scripts/i18n-extract.ts for how those are handled); if confirmed unused, mark the entries obsolete with a leading "#~ " on each msgid/msgstr line (gettext obsolete-entry convention) rather than deleting outright, so translators can see what was retired:`
    );
    for (const key of obsoleteCandidates) {
      console.warn(`  - ${key}`);
    }
  }

  if (newlyDiscovered.length > 0) {
    console.log(
      `\ni18n:extract — ${newlyDiscovered.length} new key(s) found in src/ that aren't in i18n/en.po yet. Add a msgstr for each in i18n/en.po and i18n/id.po:`
    );
    for (const key of newlyDiscovered) {
      console.log(`  - ${key}`);
    }
  }
}
