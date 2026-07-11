---
"awcms-mini": minor
---

Replace direct `blog_content`/`news_portal` cross-module imports with
capability ports (Issue #681, epic #679 platform-hardening).

`blog_content` and `news_portal`'s `application`/`domain` code
previously imported each other's implementation directly in both
directions (`blog_content`'s R2-only media validation importing
`news_portal`'s media registry; `news_portal`'s homepage section
composer importing `blog_content`'s post/category queries and gallery
renderer) — a genuine source-level cycle invisible to either module's
`module.ts` `dependencies` array. Both directions now go through pure,
neutral port interfaces (`src/modules/_shared/ports/news-media-port.ts`,
`public-content-port.ts`), implemented by each module's own concrete
adapter and injected by the caller — the route handler, already this
repo's established composition-root layer. The shared gallery-block
renderer (used by both modules) moved to
`src/modules/_shared/rendering/gallery-block-renderer.ts`.

`ModuleDescriptor` gains an optional `capabilities` field
(`provides`/`consumes`) documenting this relationship, separate from
`dependencies` (which still governs enable/disable lifecycle ordering
only — unchanged by this issue). A new structural test,
`tests/unit/module-boundary.test.ts`, fails CI if either module's
`application`/`domain` tree ever imports the other's implementation
directly again. See ADR-0011 for the full design rationale.

No behavior change: all existing `blog_content`/`news_portal`
integration tests pass unchanged, confirming this is a pure
architectural refactor.
