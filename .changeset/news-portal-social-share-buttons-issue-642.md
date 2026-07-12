---
"awcms-mini": minor
---

Add public social share buttons and expanded Open Graph/Twitter Card
metadata for published news articles (Issue #642, epic `news_portal`
#631-#642/#649): native Web Share API, copy-link, WhatsApp, Telegram,
Facebook, LinkedIn, X, and email on `/news/{slug}` and
`/blog/{tenantCode}/{slug}` — every link built from the server-resolved
canonical URL only (never the request's raw querystring/tracking
parameters), `rel="noopener noreferrer"` on all external links, no
third-party script loaded (native share/copy-link is a small same-origin
static file, `public/js/news-share.js`). Instagram has no supported
web-share URL, so it is never a fake button — only a short note pointing
to native share/copy-link. Adds `og:title`/`og:description`/`og:url`/
`og:site_name` and `twitter:title`/`twitter:description`/`twitter:card`
to the public page shell (derived from the same title/description/
canonical URL fields already rendered — `og:image`/`twitter:image` remain
gated on a verified R2 media object per Issue #636). New per-platform
`NEWS_SHARE_*_ENABLED` config flags (all default `true`) let operators
disable the widget or a specific platform.
