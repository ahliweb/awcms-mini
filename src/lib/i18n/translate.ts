import { loadCatalog } from "./catalog";
import { DEFAULT_LOCALE, type SupportedLocale } from "./locale";

export type TranslateParams = Record<string, string | number>;
export type Translator = (key: string, params?: TranslateParams) => string;

/**
 * Substitutes `{param}` placeholders. Unknown placeholders are left as-is
 * (fail visibly during development rather than silently dropping text).
 */
export function interpolate(
  template: string,
  params?: TranslateParams
): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Builds a synchronous `t(key, params)` translator for one locale. Fallback
 * chain: requested locale's catalog -> `DEFAULT_LOCALE` catalog -> the raw
 * key itself (so a missing translation renders as a visible key, e.g.
 * `auth.login.submit`, rather than throwing or silently showing blank text).
 *
 * Async factory (loads/caches the `.po` catalogs) so it can be awaited once
 * per request in Astro frontmatter — `const t = await createTranslator(locale);`
 * — then called synchronously throughout the template.
 */
export async function createTranslator(
  locale: SupportedLocale,
  i18nDir?: string
): Promise<Translator> {
  const primary = await loadCatalog(locale, i18nDir);
  const fallback =
    locale === DEFAULT_LOCALE
      ? primary
      : await loadCatalog(DEFAULT_LOCALE, i18nDir);

  return (key: string, params?: TranslateParams): string => {
    const template = primary[key] ?? fallback[key] ?? key;
    return interpolate(template, params);
  };
}
