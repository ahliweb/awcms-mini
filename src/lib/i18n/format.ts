import type { SupportedLocale } from "./locale";

/** BCP-47 tags for `Intl` — internal to this module; callers use `SupportedLocale`. */
const INTL_LOCALE_TAG: Record<SupportedLocale, string> = {
  en: "en-US",
  id: "id-ID"
};

/** Fixed per doc 14 §Internationalization — LAN-first deployments are single-timezone. */
const TIMEZONE = "Asia/Jakarta";

export function formatNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE_TAG[locale]).format(value);
}

/** IDR currency, no decimals (Rupiah has no minor unit in everyday use). */
export function formatCurrencyIDR(
  amount: number,
  locale: SupportedLocale
): string {
  return new Intl.NumberFormat(INTL_LOCALE_TAG[locale], {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(amount);
}

export function formatDate(date: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE_TAG[locale], {
    dateStyle: "medium",
    timeZone: TIMEZONE
  }).format(date);
}

export function formatDateTime(date: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE_TAG[locale], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TIMEZONE
  }).format(date);
}
