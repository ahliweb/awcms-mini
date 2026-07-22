---
"awcms-mini": patch
---

UX polish: responsive mobile-first layout + professional micro-interactions for the six tenant/billing SaaS-control-plane admin screens, on top of the shared motion/design-token foundation.

- **Design-token convergence**: the five newer screens (tenant-entitlement, tenant-lifecycle, tenant-provisioning, usage-metering, subscription-billing) referenced never-defined `--space-*` tokens with hardcoded rem fallbacks (`1.5rem`/`1rem`/`0.75rem`/`0.5rem`/`0.25rem`), `0.85rem` font sizes, and hardcoded colour fallbacks (`#d4d4d8`/`#e4e4e7`/`#71717a`/`#b91c1c`). All now route through the real `--sp-*`/`--fs-*`/`--color-*` tokens, so they finally adapt to theme and stay consistent with the rest of the admin surface.
- **Cards**: panels now use `--color-surface` + `--shadow-sm` instead of a bare border, lifting each section visually.
- **Responsive (doc 14 §Responsif)**: inputs/selects are `width: 100%; min-width: 0` and their labels flex-wrap, so `size="40"` fields no longer force horizontal page scroll at 320px; the hand-rolled SSR tables in tenant-entitlement and usage-metering are wrapped in an `overflow-x: auto` scroll container; primary/secondary buttons get `min-height: 44px` touch targets.
- **Motion (through the shared tokens/keyframes only)**: hand-rolled action banners and the client-filled result panels (state/timeline/subscriptions/invoices) animate in with `awcms-slide-up-in` on reveal — all state-triggered on elements that are `hidden` at SSR load (or a collapsed `<details>`), so no SSR-visible primary content is ever animated from `opacity: 0`. Table rows and row-action buttons/links get subtle hover feedback via the global control transition. Everything is neutralised by the existing `prefers-reduced-motion` block.

CSS/markup only — no behaviour, data-fetch, auth, or i18n changes.
