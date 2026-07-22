---
"awcms-mini": patch
---

Redesign the login screen into a modern, mobile-first auth card (modelled on
awcms's login, adapted to awcms-mini's design tokens). Adds a brand header
(gradient mark + wordmark), a "Sign in" title + subtitle, a subtle gradient
background, a single-tenant "Signing in to <name>" readout (when the tenant
picker resolves exactly one active tenant), a styled `<select>` with a
CSS-drawn caret, an accessible password show/hide toggle (CSP-safe, wired in
the bundled script), a distinct outline style for the Google button, and a
transform-only card entrance (never `opacity:0`, so an axe contrast scan can't
flag mid-animation text). The stable DOM contract (`#login-form`, `#tenant-id`,
`#login-identifier`, `#password`, `#login-submit`, `#login-error`), the
tenant-picker/Turnstile/Google-OIDC logic, and the `X-AWCMS-Mini-Tenant-ID`
submit flow are unchanged. Eight new i18n keys (heading, subtitle, footer,
tenant-context label, password show/hide + their aria labels) in en.po/id.po.
