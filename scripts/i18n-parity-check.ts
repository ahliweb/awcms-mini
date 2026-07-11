/**
 * EN/ID/POT catalog key parity gate (Issue #685, epic #679
 * platform-hardening — "Add EN/ID/POT key parity gate").
 *
 * `i18n/en.po`/`i18n/id.po` (the two runtime locales, `src/lib/i18n/
 * locale.ts`'s `SUPPORTED_LOCALES`) and `i18n/messages.pot` (the
 * extraction template) had NO automated parity check before this issue —
 * `tests/i18n.test.ts` only exercises `parsePo`/`createTranslator` against
 * small synthetic in-memory fixtures, never the real catalog files. A key
 * present in `en.po` but missing from `id.po` silently falls back to the
 * English string for Indonesian users (`src/lib/i18n/translate.ts`'s
 * locale -> DEFAULT_LOCALE fallback) — not a crash, so it would never
 * surface as a bug report, just a silent, permanent translation gap.
 *
 * Reuses the same hand-rolled `.po` parser (`src/lib/i18n/po-parser.ts`)
 * the runtime itself uses — parity is checked against exactly what the app
 * would actually load, not a second independent parser that could drift
 * from the real one's parsing quirks.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parsePo } from "../src/lib/i18n/po-parser";

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

export async function runI18nParityCheck(
  rootDir = process.cwd()
): Promise<Problem[]> {
  const [enSource, idSource, potSource] = await Promise.all([
    readFile(path.join(rootDir, EN_PO_PATH), "utf8"),
    readFile(path.join(rootDir, ID_PO_PATH), "utf8"),
    readFile(path.join(rootDir, POT_PATH), "utf8")
  ]);

  const catalogs = {
    "en.po": new Set(Object.keys(parsePo(enSource))),
    "id.po": new Set(Object.keys(parsePo(idSource))),
    "messages.pot": new Set(Object.keys(parsePo(potSource)))
  };

  return checkKeyParity(catalogs);
}

if (import.meta.main) {
  const problems = await runI18nParityCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}: ${problem.message}`);
    }

    console.error(
      `\ni18n:parity:check GAGAL — ${problems.length} temuan. Tambahkan msgid yang hilang ke katalog yang disebutkan (jangan hapus dari yang sudah ada kecuali memang string itu benar-benar tidak dipakai lagi).`
    );
    process.exitCode = 1;
  } else {
    console.log(
      "i18n:parity:check OK — en.po/id.po/messages.pot key sets sinkron."
    );
  }
}
