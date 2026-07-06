/**
 * Locale resolution (pure) — doc 14 §Internationalization.
 *
 * Precedence: per-browser cookie preference (set by the language switcher)
 * -> tenant `default_locale` -> hardcoded `en` fallback. Cookie, not
 * localStorage: unlike the theme toggle (pure CSS, can flash-fix client-side
 * before paint), locale changes the actual SSR-rendered text — the server
 * must know the locale *before* it renders, and only a cookie is sent with
 * the request itself. This is a deliberate correction from an earlier draft
 * of doc 14 that suggested localStorage for this; localStorage cannot solve
 * SSR-time text selection, only the after-the-fact CSS-attribute trick
 * theme uses.
 */

export const SUPPORTED_LOCALES = ["en", "id"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LOCALE_COOKIE_NAME = "awcms_mini_locale";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Each language's own native name + flag — shown as-is, never translated
 * into the current UI locale (standard convention: a user must be able to
 * find their language even if the current UI is one they can't read). Used
 * by `LanguageSwitcher.astro` and the Settings locale dropdown.
 */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  id: "Bahasa Indonesia"
};

export const LOCALE_FLAGS: Record<SupportedLocale, string> = {
  en: "🇬🇧",
  id: "🇮🇩"
};

export type LocaleResolutionInput = {
  cookieLocale?: string | null;
  tenantDefaultLocale?: string | null;
};

/**
 * Resolves the effective locale from the precedence chain above. Never
 * throws and never returns an unsupported value — always one of
 * `SUPPORTED_LOCALES`.
 */
export function resolveLocale(input: LocaleResolutionInput): SupportedLocale {
  if (isSupportedLocale(input.cookieLocale)) {
    return input.cookieLocale;
  }

  if (isSupportedLocale(input.tenantDefaultLocale)) {
    return input.tenantDefaultLocale;
  }

  return DEFAULT_LOCALE;
}
