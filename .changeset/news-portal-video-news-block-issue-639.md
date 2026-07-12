---
"awcms-mini": minor
---

Add a safe `video_news` content block for `blog_content` posts/pages
(Issue #639, epic `news_portal`).

A `video_news` block (`{ provider, videoId, title?, caption?,
thumbnailMediaObjectId?, durationSeconds?, sourceLabel? }`) is now a
recognized `content_json` block type, alongside paragraph, heading,
list, quote, and gallery. `provider` is validated against an allowlist
(currently only `youtube`) and `videoId` is validated/normalized
server-side from either a bare video id or a common YouTube URL form
(`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`) — unconditionally, for
every tenant, independent of full-online R2-only mode. Every
`video_news` block is rebuilt at write time from only its known fields,
so no unrecognized field (e.g. a smuggled raw embed field) is ever
persisted; a request with an unsupported provider or an invalid/
malformed `videoId` is rejected with `400 VALIDATION_ERROR`.

The block's optional custom `thumbnailMediaObjectId` follows the exact
same R2-only-mode-gated policy Issue #636 established for
`featuredMediaId` and gallery images: when full-online R2-only mode is
active for the tenant, a present thumbnail reference must resolve to an
existing, same-tenant, `verified`/`attached` R2 media object — a
cross-tenant, deleted, or unverified reference is rejected with
`422 NEWS_MEDIA_REFERENCE_INVALID`. A missing thumbnail is never an
error (a custom thumbnail is optional). This check is enforced at
post/page create and update, and at revision restore.

The public post detail routes (`/news/{slug}`,
`/blog/{tenantCode}/{slug}`) render a `video_news` block as a safe
`<iframe>` embed built only from the validated `provider`+`videoId`
(YouTube's privacy-enhanced `youtube-nocookie.com` embed domain,
also allow-listed in the CSP `frame-src` directive) — never from any
raw HTML the client submitted. The resolved custom thumbnail, when one
verifies successfully, is rendered as a separate `<img>` alongside it.
