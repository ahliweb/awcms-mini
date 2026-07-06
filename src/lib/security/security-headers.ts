/**
 * Security response headers (Issue #437 — security hardening, OWASP A05
 * Security Misconfiguration, ASVS V14 HTTP Security Configuration, ISO
 * 27001 Annex A.8.28 secure coding). Applied to every response by
 * `src/middleware.ts`, mirroring how it already sets `X-Correlation-ID` on
 * every response.
 *
 * Found live while auditing this exact repo (Issue #437): neither
 * `src/middleware.ts` nor the optional nginx template
 * (`deploy/nginx/awcms-mini.conf.example`) set any of these headers — a
 * real, confirmed gap (grep for `Content-Security-Policy` /
 * `Strict-Transport-Security` / `X-Frame-Options` /
 * `X-Content-Type-Options` across `src/` returned nothing before this
 * change).
 *
 * Content-Security-Policy is deliberately NOT built here. Two hand-rolled
 * approaches were tried first and abandoned after *real browser*
 * verification (a headless-Chrome/CDP session — curl can't do this, it
 * never executes JS/CSS so it can't see a CSP violation):
 *
 * 1. A per-request nonce — Astro's compiler silently drops a `nonce="..."`
 *    attribute from an `is:inline` script tag, so the header's nonce could
 *    never match.
 * 2. A hand-rolled SHA-256 hash allowlist for the one *known* `is:inline`
 *    script — this missed several *other* inline `<script>`/`<style>`
 *    blocks Astro turned out to emit per-component (`ThemeToggle.astro`,
 *    `LanguageSwitcher.astro`, the admin logout button's script, and their
 *    scoped `<style>` blocks) — a real headless-Chrome check caught actual
 *    CSP violations blocking these on `/admin` (the theme toggle's click
 *    handler never even attached).
 *
 * `script-src`/`style-src` (and the other directives) are instead delegated
 * to Astro's own built-in `security.csp` feature (`astro.config.mjs`),
 * which computes the correct hash for whatever *it* actually inlines and
 * can't drift the way a hand-maintained list can. For this SSR ("server"
 * output + adapter) build it sets a real `Content-Security-Policy` response
 * header (verified live via `curl -D -`) — not the `<meta http-equiv>`
 * fallback its docs describe for static output — so `frame-ancestors` is
 * fully enforced there too. `X-Frame-Options: DENY` below is kept as a
 * second, independent clickjacking-protection layer regardless.
 *
 * One remaining exception: Astro's hashing doesn't cover `is:inline`
 * scripts at all (by design — `is:inline` opts a script out of Astro's own
 * processing pipeline, so it never sees the content to hash). The one
 * `is:inline` script left in the codebase (the theme-flash-prevention
 * snippet in `src/layouts/AdminLayout.astro`, which must run synchronously
 * before paint) registers its own hash manually via
 * `security.csp.scriptDirective.hashes` — see
 * `src/lib/security/theme-init-script.ts` for that single source of truth
 * and `tests/theme-init-script.test.ts` for the test that keeps it in sync.
 *
 * HSTS is gated on `isProduction` (mirrors the existing `AUTH_COOKIE_SECURE`
 * gating pattern in `src/pages/api/v1/auth/login.ts`): sending it from a
 * plain-HTTP `bun run dev` server would be a no-op per spec (browsers only
 * honor `Strict-Transport-Security` received over an already-secure
 * connection) but is still worth gating explicitly so it's never emitted
 * from an environment that isn't really TLS-terminated.
 */

export type SecurityHeaderOptions = {
  /** Gates `Strict-Transport-Security` — only meaningful once TLS is real. */
  isProduction: boolean;
};

/**
 * Returns the full set of security headers to apply to a response. Order is
 * deterministic (used verbatim by tests) but does not matter functionally.
 * Deliberately does NOT include `Content-Security-Policy` — see module doc
 * comment above: that's Astro's own `security.csp` feature
 * (`astro.config.mjs`), which sets its own `Content-Security-Policy`
 * response header for this SSR build, independent of this function.
 */
export function buildSecurityHeaders(
  options: SecurityHeaderOptions
): Array<[string, string]> {
  const headers: Array<[string, string]> = [
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    [
      "Permissions-Policy",
      "geolocation=(), camera=(), microphone=(), payment=()"
    ]
  ];

  if (options.isProduction) {
    headers.push([
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    ]);
  }

  return headers;
}
