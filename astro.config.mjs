import { defineConfig } from "astro/config";
import node from "@astrojs/node";

import { THEME_INIT_SCRIPT_HASH } from "./src/lib/security/theme-init-script.ts";

// SSR di atas Bun via adapter @astrojs/node (standalone). Ini pengecualian
// Bun-only yang tersanksi (ADR-0002; doc 10 §Standar platform backend;
// doc 18 §Runtime & tooling) karena Astro belum punya adapter Bun
// first-party. Entry hasil build dijalankan `bun ./dist/server/entry.mjs`
// — runtime tetap Bun, hanya paket adapter yang bernama "node".
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  site: "http://localhost:4321",
  // Content-Security-Policy (Issue #437 — security hardening). Astro's own
  // built-in feature, not a hand-rolled hash/nonce (see
  // src/lib/security/security-headers.ts's doc comment): a hand-rolled
  // hash allowlist was tried first and found — via a real headless-Chrome
  // check, not just curl, since curl never executes JS/CSS and can't see a
  // CSP violation — to miss several inline `<script>`/`<style>` blocks
  // Astro emits per-component (ThemeToggle.astro, LanguageSwitcher.astro,
  // the admin logout button's script, and their scoped `<style>` blocks),
  // which would have silently broken the theme toggle, language switcher,
  // and logout button in a real browser under a strict hand-rolled CSP.
  // Astro computes the correct hash for whatever *it* actually inlines, so
  // it can't drift the way a manually maintained hash list can. For this
  // SSR ("server" output + adapter) build, Astro sets it as a real
  // `Content-Security-Policy` response HEADER (verified live via `curl -D
  // -`), not the `<meta http-equiv>` fallback its docs describe for static
  // output — which is strictly better here since a header (unlike `<meta>`)
  // properly supports `frame-ancestors` per spec. `directives` below adds
  // the extra directives this repo wants alongside Astro's own
  // script-src/style-src hashes. `X-Frame-Options: DENY`
  // (`src/lib/security/security-headers.ts`/`src/middleware.ts`) still
  // provides the same clickjacking protection as a second, independent
  // layer (older browser compatibility).
  //
  // Known limitation (documented, not silently dropped): unsupported in
  // `astro dev` (Vite dev server) — verify via `bun run build` +
  // `bun ./dist/server/entry.mjs`/`bun run preview`, which is how this repo
  // is actually deployed (doc 18 §Topologi deployment) anyway.
  //
  // `scriptDirective.hashes` registers ONE extra, manually-computed hash:
  // real headless-Chrome verification found Astro's own hashing does NOT
  // cover `is:inline` scripts (by design — `is:inline` opts a script out of
  // Astro's processing pipeline entirely, and Astro can only hash what it
  // processes). The one `is:inline` script in this codebase
  // (`src/layouts/AdminLayout.astro`'s theme-flash-prevention snippet,
  // required to run synchronously in `<head>` before body paint) needs its
  // hash added here instead. See `src/lib/security/theme-init-script.ts`
  // for the single source of truth this hash is computed from, and
  // `tests/theme-init-script.test.ts` for the test that keeps them in sync.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
      ],
      scriptDirective: {
        hashes: [THEME_INIT_SCRIPT_HASH]
      }
    }
  }
});
