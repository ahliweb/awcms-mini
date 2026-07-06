import type { AstroCookies } from "astro";

import {
  LOCALE_COOKIE_NAME,
  resolveLocale,
  type SupportedLocale
} from "./locale";

/**
 * Astro-specific glue around the pure `resolveLocale` — reads the locale
 * cookie the language switcher sets. Kept separate from `locale.ts` so the
 * resolution precedence itself stays framework-agnostic and unit-testable
 * without an `AstroCookies` fixture.
 */
export function resolveRequestLocale(
  cookies: AstroCookies,
  tenantDefaultLocale?: string | null
): SupportedLocale {
  const cookieLocale = cookies.get(LOCALE_COOKIE_NAME)?.value ?? null;

  return resolveLocale({ cookieLocale, tenantDefaultLocale });
}
