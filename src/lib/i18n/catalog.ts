import path from "node:path";

import { parsePo, type ParsedCatalog } from "./po-parser";
import type { SupportedLocale } from "./locale";

/**
 * Catalogs are bundled `.po` files at the repo root `i18n/` directory (not
 * the database — doc 14 §Internationalization layer 1), read relative to
 * `process.cwd()` the same way `scripts/db-migrate.ts` resolves `sql/`. Cwd
 * is the repo root in both `astro dev` and the built server
 * (`bun ./dist/server/entry.mjs` runs from `/app`, the repo root bind mount).
 */
const DEFAULT_I18N_DIR = path.resolve(process.cwd(), "i18n");

const catalogCache = new Map<SupportedLocale, ParsedCatalog>();

/**
 * Loads (and caches) the `.po` catalog for one locale. Cached per-locale for
 * the life of the process — catalogs are static build artifacts, not
 * expected to change at runtime.
 */
export async function loadCatalog(
  locale: SupportedLocale,
  i18nDir: string = DEFAULT_I18N_DIR
): Promise<ParsedCatalog> {
  const cached = catalogCache.get(locale);

  if (cached) {
    return cached;
  }

  const filePath = path.join(i18nDir, `${locale}.po`);
  const source = await Bun.file(filePath).text();
  const catalog = parsePo(source);

  catalogCache.set(locale, catalog);

  return catalog;
}

/** Test-only escape hatch so catalog fixtures don't leak between test files. */
export function clearCatalogCache(): void {
  catalogCache.clear();
}
