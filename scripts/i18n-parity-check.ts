/**
 * EN/ID/POT catalog key parity gate (Issue #685, epic #679
 * platform-hardening — "Add EN/ID/POT key parity gate"), extended by
 * Issue #694 (same epic — "generate messages.pot and enforce EN/ID/POT
 * key parity") to also check PLACEHOLDER parity and guard against
 * unsupported plural forms.
 *
 * `i18n/en.po`/`i18n/id.po` (the two runtime locales, `src/lib/i18n/
 * locale.ts`'s `SUPPORTED_LOCALES`) and `i18n/messages.pot` (the
 * extraction template, `scripts/i18n-extract.ts` as of Issue #694) had NO
 * automated parity check before Issue #685 — `tests/i18n.test.ts` only
 * exercises `parsePo`/`createTranslator` against small synthetic in-memory
 * fixtures, never the real catalog files. A key present in `en.po` but
 * missing from `id.po` silently falls back to the English string for
 * Indonesian users (`src/lib/i18n/translate.ts`'s locale -> DEFAULT_LOCALE
 * fallback) — not a crash, so it would never surface as a bug report,
 * just a silent, permanent translation gap. A translated string missing
 * one of the ORIGINAL's `{placeholder}` tokens is worse: `interpolate()`
 * (`src/lib/i18n/translate.ts`) leaves an unknown placeholder untouched
 * rather than throwing, so a translator who drops `{name}` from `id.po`
 * produces a string that silently renders the literal text `{name}`
 * to end users instead of failing anywhere in CI.
 *
 * Reuses the same hand-rolled `.po` parser (`src/lib/i18n/po-parser.ts`)
 * the runtime itself uses — parity is checked against exactly what the app
 * would actually load, not a second independent parser that could drift
 * from the real one's parsing quirks.
 *
 * ## Plural forms: NOT used, NOT implemented — this is a guard, not a check
 *
 * Verified (Issue #694): `grep -rn msgid_plural i18n/` returns nothing —
 * this catalog has never used gettext `msgid_plural`/`msgstr[n]` plural
 * forms, and `src/lib/i18n/po-parser.ts`'s own docstring says so
 * explicitly ("Not implemented ... msgid_plural/plural forms"). Building
 * plural-mismatch-detection logic for a feature with zero real usage and
 * zero fixtures beyond synthetic ones would be untested code for an
 * unused case — instead, `checkNoPluralForms` is a tripwire: if a future
 * `msgid_plural` ever appears in one of these three files, the gate fails
 * immediately with a message pointing out that plural-form parsing isn't
 * implemented yet, rather than silently mis-parsing (the parser would
 * currently just treat `msgid_plural "..."` as a stray comment-less line
 * and skip the whole entry — see `parsePo`'s malformed-entry handling).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parsePo, type ParsedCatalog } from "../src/lib/i18n/po-parser";

type Problem = {
  file: string;
  message: string;
};

export const EN_PO_PATH = "i18n/en.po";
export const ID_PO_PATH = "i18n/id.po";
export const POT_PATH = "i18n/messages.pot";

/**
 * Pure comparison logic, given already-parsed key sets — exported so it's
 * unit-testable against synthetic fixtures without touching the real
 * catalog files on disk.
 */
export function checkKeyParity(
  catalogs: Record<string, ReadonlySet<string>>
): Problem[] {
  const problems: Problem[] = [];
  const names = Object.keys(catalogs);

  if (names.length < 2) {
    return problems;
  }

  const allKeys = new Set<string>();

  for (const keys of Object.values(catalogs)) {
    for (const key of keys) allKeys.add(key);
  }

  for (const key of allKeys) {
    const missingFrom = names.filter((name) => !catalogs[name]!.has(key));

    if (missingFrom.length > 0 && missingFrom.length < names.length) {
      problems.push({
        file: missingFrom.map((n) => `i18n/${n}`).join(", "),
        message: `Key "${key}" is missing (present in ${names
          .filter((n) => !missingFrom.includes(n))
          .join(", ")}, absent from ${missingFrom.join(", ")}).`
      });
    }
  }

  return problems;
}

/**
 * Extracts the set of `{word}` placeholder names a translated string
 * references. `{word}` is the only placeholder syntax this catalog
 * actually uses (verified via `grep -oE '\{[a-zA-Z0-9_]+\}' i18n/en.po` —
 * a small closed set: `{name}`, `{days}`, `{page}`, `{permission}`,
 * `{postId}`, `{role}`, `{tenantCode}`, `{totalPages}`; no `%s`/`%d`
 * printf-style placeholders appear anywhere in this catalog), matching
 * `interpolate()`'s own substitution regex (`src/lib/i18n/translate.ts`)
 * exactly — this check flags precisely what would otherwise render as a
 * literal, un-substituted `{placeholder}` in production.
 *
 * This match is syntactic, not semantic: it can't tell a real interpolation
 * target from incidental `{word}`-shaped text inside illustrative content.
 * `admin.news_portal.homepage_sections.config_hint` (i18n/en.po, PR #710
 * review) is a known example — its `{postId}` sits inside JSON-shape help
 * prose and is never actually substituted (the call site passes no params),
 * but both EN/ID happen to preserve it verbatim today so the gate passes.
 * If a future rewrite of that string drops/renames the bracketed word on
 * one side only, this check will report a "placeholder mismatch" that
 * isn't a real interpolation bug — that's expected, not a check defect.
 */
export function extractPlaceholders(value: string): Set<string> {
  const placeholders = new Set<string>();

  for (const match of value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    placeholders.add(match[1]!);
  }

  return placeholders;
}

/**
 * Compares EN/ID placeholder sets for every key present in both catalogs.
 * A key missing from one side entirely is `checkKeyParity`'s problem, not
 * this function's — this only runs once both sides agree the key exists.
 */
export function checkPlaceholderParity(
  en: ParsedCatalog,
  id: ParsedCatalog
): Problem[] {
  const problems: Problem[] = [];
  const sharedKeys = Object.keys(en).filter((key) => key in id);

  for (const key of sharedKeys) {
    const enPlaceholders = extractPlaceholders(en[key]!);
    const idPlaceholders = extractPlaceholders(id[key]!);

    const missingFromId = [...enPlaceholders]
      .filter((p) => !idPlaceholders.has(p))
      .sort();
    const missingFromEn = [...idPlaceholders]
      .filter((p) => !enPlaceholders.has(p))
      .sort();

    if (missingFromId.length === 0 && missingFromEn.length === 0) {
      continue;
    }

    const details: string[] = [];
    if (missingFromId.length > 0) {
      details.push(`id.po is missing {${missingFromId.join("}, {")}}`);
    }
    if (missingFromEn.length > 0) {
      details.push(`en.po is missing {${missingFromEn.join("}, {")}}`);
    }

    problems.push({
      file: "i18n/en.po, i18n/id.po",
      message: `Key "${key}" has mismatched placeholders (${details.join("; ")}).`
    });
  }

  return problems;
}

/**
 * Tripwire for gettext plural forms — see file header §Plural forms.
 * Deliberately a presence check, not a parity check: this catalog has no
 * plural-form usage to compare, so there is nothing to validate beyond
 * "did someone just introduce the feature this parser doesn't support."
 */
export function checkNoPluralForms(sources: Record<string, string>): Problem[] {
  const problems: Problem[] = [];

  for (const [name, source] of Object.entries(sources)) {
    if (/^\s*msgid_plural\b/m.test(source)) {
      problems.push({
        file: `i18n/${name}`,
        message:
          "Found msgid_plural, but src/lib/i18n/po-parser.ts does not implement gettext plural forms (a deliberate, documented design decision — this catalog has never used plural forms). Either remove msgid_plural from this entry, or implement plural-form parsing/runtime selection (po-parser.ts + translate.ts) before relying on one."
      });
    }
  }

  return problems;
}

export async function runI18nParityCheck(
  rootDir = process.cwd()
): Promise<Problem[]> {
  const [enSource, idSource, potSource] = await Promise.all([
    readFile(path.join(rootDir, EN_PO_PATH), "utf8"),
    readFile(path.join(rootDir, ID_PO_PATH), "utf8"),
    readFile(path.join(rootDir, POT_PATH), "utf8")
  ]);

  const enCatalog = parsePo(enSource);
  const idCatalog = parsePo(idSource);
  const potCatalog = parsePo(potSource);

  const catalogs = {
    "en.po": new Set(Object.keys(enCatalog)),
    "id.po": new Set(Object.keys(idCatalog)),
    "messages.pot": new Set(Object.keys(potCatalog))
  };

  return [
    ...checkKeyParity(catalogs),
    ...checkPlaceholderParity(enCatalog, idCatalog),
    ...checkNoPluralForms({
      "en.po": enSource,
      "id.po": idSource,
      "messages.pot": potSource
    })
  ];
}

if (import.meta.main) {
  const problems = await runI18nParityCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}: ${problem.message}`);
    }

    console.error(
      `\ni18n:parity:check GAGAL — ${problems.length} temuan. Tambahkan msgid yang hilang ke katalog yang disebutkan, atau samakan placeholder {name}/dst antara en.po dan id.po (jangan hapus key yang sudah ada kecuali memang string itu benar-benar tidak dipakai lagi — lihat \`bun run i18n:extract\`'s obsolete-candidate report).`
    );
    process.exitCode = 1;
  } else {
    console.log(
      "i18n:parity:check OK — en.po/id.po/messages.pot key sets dan placeholder EN/ID sinkron; tidak ada msgid_plural."
    );
  }
}
