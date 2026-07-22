---
"awcms-mini": minor
---

Add a shared motion foundation for professional, accessible micro-animations. New `--motion-duration-*`/`--motion-ease-*` tokens and `awcms-fade-in`/`slide-up-in`/`scale-in` keyframes in `tokens.css`, a global short transition on interactive controls (+1px active press), and a global `prefers-reduced-motion: reduce` block that neutralises all motion. Shared components animate their entrances: `StateNotice`/`ActionBanner` (slide-up), `ConfirmDialog` (scale-in + backdrop fade), `AdminLayout` (per-navigation content fade-in, drawer easing), `DataTable` (row hover). All motion routes through the tokens so it is theme- and reduced-motion-safe, animates only opacity/transform/colour (no layout shift), and lifts every screen via the shared layer.
