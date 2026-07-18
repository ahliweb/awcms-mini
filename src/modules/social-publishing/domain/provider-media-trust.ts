/**
 * Shared provider media-URL trust check (Issue #862, epic `social_publishing`
 * #643-#647). The SINGLE source of truth every provider adapter uses to decide
 * whether a resolved media URL genuinely originates from this deployment's
 * configured R2 public base before that URL is ever handed to a third-party API
 * (Meta's Graph API, LinkedIn's Images API).
 *
 * Pure, no I/O, no env/port reads — the caller resolves the trusted public base
 * URL (Meta reads `env.NEWS_MEDIA_R2_PUBLIC_BASE_URL` directly; LinkedIn gets it
 * from the injected `NewsMediaPort.resolveMediaPublicBaseUrl`, Issue #859) and
 * passes it in. This keeps the file importable by BOTH the `domain/` Meta path
 * (`meta-publish-content.ts`) and the `infrastructure/` LinkedIn adapter
 * (`linkedin-provider-adapter.ts`) with zero cross-module or intra-module import
 * cycle (this file imports nothing).
 *
 * ## Why exact `URL.host` equality, never a prefix/substring check (Issue #862)
 *
 * The LinkedIn adapter historically used `url.startsWith(publicBaseUrl)`, which
 * is bypassable — `https://media.example.com` is a string-prefix of
 * `https://media.example.com.evil.com/x.jpg` (prefix collision),
 * `https://media.example.com@evil.com/x.jpg` (`@`-userinfo — the real host is
 * `evil.com`), and it never rejects a `http:` downgrade. Parsing with
 * `new URL()` and comparing the parsed `host` sidesteps that entire bug class:
 *
 * - `URL.host` for `...com.evil.com` is `evil.com...`? No — it is
 *   `media.example.com.evil.com`, which is NOT equal to `media.example.com`.
 * - `URL.host` for `...@evil.com` is `evil.com` (userinfo is stripped from
 *   `host`), NOT equal to `media.example.com`.
 * - `URL.host` for a trailing-dot FQDN `media.example.com.` is
 *   `media.example.com.` (the dot is preserved literally), NOT equal to the
 *   configured `media.example.com` — the same trailing-dot lesson Issue #635
 *   applied to `checkNewsMediaR2PublicBaseUrlProductionSafe`.
 *
 * `host` (not `hostname`) is used deliberately so an unexpected `:port` on the
 * target that the configured base does not carry is also a mismatch.
 */
export function isMediaUrlFromTrustedBase(
  url: string,
  publicBaseUrl: string
): boolean {
  if (!publicBaseUrl) {
    return false;
  }

  let target: URL;
  let base: URL;

  try {
    target = new URL(url);
    base = new URL(publicBaseUrl);
  } catch {
    return false;
  }

  if (target.protocol !== "https:") {
    return false;
  }

  return target.host === base.host;
}
