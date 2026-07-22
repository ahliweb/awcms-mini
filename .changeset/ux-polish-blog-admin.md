---
"awcms-mini": patch
---

UX polish for the admin blog screens (`src/pages/admin/blog/**`): responsive mobile-first refinements and subtle, professional motion — no behavior or logic changes.

- **Motion (via the shared `tokens.css` motion tokens/keyframes, so `prefers-reduced-motion` still neutralises everything):** post-mutation feedback banners now slide in when unhidden (matching `ActionBanner.astro`); list/table rows get a subtle hover highlight matching the shared `DataTable` idiom; dashboard/menu/ad cards gain a gentle hover elevation (box-shadow only, no layout shift). No SSR-visible primary content is animated from `opacity: 0`.
- **Responsive:** filter toolbars on the post/page list screens stack into a single full-width, tappable column on phones; the dashboard summary grid and the internal-tag-links deployment grid collapse to one column on very narrow screens, avoiding horizontal scroll at 320px.

Token-only CSS/markup changes; every value uses existing design tokens.
