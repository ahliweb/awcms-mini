---
"awcms-mini": patch
---

UX/a11y: fix dark-mode contrast failures and converge module screens onto the canonical design-token idioms.

- **Warning status/health pills**: the 7 hand-rolled `.status-pill`/`.health-pill` warning rules across the module + blog screens set no text `color`, inheriting `--color-text` which flips near-white in dark mode over amber (WCAG AA fail, measured 1.82:1). Added a shared `--color-warning-contrast` token (also adopted by `StatusBadge.astro`) — now 7.71:1 dark / 5.20:1 light.
- **Feedback banners**: 24 SaaS-control-plane / platform-evolution screens referenced never-defined `--color-*-surface`/`--color-*-subtle` tokens, so their hardcoded light-tint fallbacks rendered unconditionally and never adapted to dark mode (the `-subtle` ones had no text color → 1.08:1 in dark). Converged all of them onto the canonical `color-mix(... 15%, --color-surface)` + semantic border idiom used by `ActionBanner.astro` (11+:1 in both themes).
- **subscription-billing**: a failed invoices lookup returned silently (blank panel, indistinguishable from "no invoices") and the whole client `load()` had no try/catch. Now surfaces network/not-found errors like the sibling subscriptions call.
- **autocomplete**: added `autocomplete="new-password"` to the create-user and tenant-provisioning owner-password fields (an admin setting someone else's password should not autofill the admin's own credentials).
