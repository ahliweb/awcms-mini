/**
 * i18n dasar (doc 14): locale id/en/ms/ar, resolusi dari Accept-Language
 * dengan fallback default tenant/aplikasi. Kamus penuh dikelola modul
 * localization-ui.
 */

export const SUPPORTED_LOCALES = ["id", "en", "ms", "ar"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const RTL_LOCALES: readonly Locale[] = ["ar"];

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Resolusi locale dari header Accept-Language (subset sederhana, q-aware). */
export function resolveLocale(acceptLanguage: string | null, fallback: Locale = "id"): Locale {
  if (!acceptLanguage) return fallback;
  const candidates = acceptLanguage
    .split(",")
    .map((part) => {
      const [tagRaw, qRaw] = part.trim().split(";q=");
      const tag = (tagRaw ?? "").trim().toLowerCase().split("-")[0] ?? "";
      const q = qRaw ? Number.parseFloat(qRaw) : 1;
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((candidate) => candidate.tag.length > 0)
    .sort((a, b) => b.q - a.q);
  for (const candidate of candidates) {
    if (isSupportedLocale(candidate.tag)) return candidate.tag;
  }
  return fallback;
}

export function textDirection(locale: Locale): "ltr" | "rtl" {
  return RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}
