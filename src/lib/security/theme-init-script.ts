/**
 * Theme-flash-prevention script body (Issue #437 — security hardening).
 * Single source of truth for the one `is:inline` script in the codebase
 * (`src/layouts/AdminLayout.astro`'s `<head>`), shared between the page
 * that renders it (via `set:html`, so the rendered bytes are always
 * exactly this string — never hand-authored a second time) and
 * `astro.config.mjs` (which registers `THEME_INIT_SCRIPT_HASH` as an extra
 * allowed `script-src` hash).
 *
 * Why a manual hash for just this one script: Astro's own built-in
 * `security.csp` feature (`astro.config.mjs`) automatically hashes
 * whatever scripts/styles *it* processes and inlines — verified live to
 * correctly cover `ThemeToggle.astro`, `LanguageSwitcher.astro`, and the
 * admin logout button's script, none of which are marked `is:inline`. This
 * one script, however, needs `is:inline` (it must run synchronously in
 * `<head>`, before body paint, to avoid a flash of the wrong theme —
 * bundling/deferring it like a normal Astro script would reintroduce that
 * flash). `is:inline` explicitly opts a script OUT of Astro's processing
 * pipeline — real headless-Chrome verification (curl can't see this; it
 * never executes JS) showed Astro's CSP feature does not hash `is:inline`
 * scripts at all, so this one needs its hash registered manually via
 * `security.csp.scriptDirective.hashes`.
 *
 * Keeping this script's body server-injection-free (reads its default from
 * the `data-tenant-default-theme` HTML attribute set by AdminLayout.astro,
 * not `define:vars` textual interpolation) is what makes a single static
 * hash correct for every tenant/theme: `define:vars` was tried first and
 * found — also via live headless-Chrome verification — to make the actual
 * rendered bytes vary per request, so a hash computed once could only ever
 * match ONE of those variants and silently blocked the rest (no flash
 * protection was applied for any tenant whose value didn't match).
 *
 * `tests/theme-init-script.test.ts` asserts `THEME_INIT_SCRIPT_HASH` really
 * is this exact string's SHA-256 — if anyone edits the body below without
 * updating the hash (or vice versa), that test fails instead of silently
 * shipping a script the browser will refuse to run.
 */
export const THEME_INIT_SCRIPT_BODY = `(function () {
  var STORAGE_KEY = "awcms_mini_theme";
  var tenantDefaultTheme =
    document.documentElement.getAttribute("data-tenant-default-theme") ||
    "system";
  var stored = localStorage.getItem(STORAGE_KEY) || tenantDefaultTheme;
  var resolved =
    stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.setAttribute("data-theme", resolved);
})();`;

// See tests/theme-init-script.test.ts — kept in sync by that test, not by
// hand discipline alone.
export const THEME_INIT_SCRIPT_HASH =
  "sha256-nLhd693cGQjNH4T21n0Bl5PrlirImH2NPjiy3gJp+5A=";
