---
"awcms-mini": minor
---

Add application-level request body size limits across every `/api/v1` endpoint (Issue #686, epic #679, platform-hardening).

Most handlers previously called `request.json()`/`request.text()` directly with no size cap of their own — a reverse-proxy `client_max_body_size` protects nothing for direct/local access (offline/LAN deployments often run with no proxy in front at all), and nothing at all protects against a chunked-transfer or `Content-Length`-lying body.

New shared reader (`src/lib/security/request-body-limit.ts`) is now the only place any `/api/*` handler reads a request body — `readJsonBody`/`readTextBody`/`readFormBody` enforce a declared `Content-Length` check before any byte is read, and a running streamed-byte count that aborts the read the instant it's exceeded (catching a chunked or `Content-Length`-lying body the header check alone would miss). Two tiers: `default` (128 KiB, most endpoints) and `large` (5 MiB, content-heavy endpoints — blog post/page/template/theme, email template/announcement, news-portal homepage sections, sync push/pull). A hard ceiling (`BODY_SIZE_HARD_CEILING_BYTES`, 10 MiB) bounds every tier, enforced by a unit test invariant, not just documentation.

All 71 call sites across 57 route files migrated. A new `checkContentLengthCeiling` backstop in `src/middleware.ts` additionally rejects any `/api/*` request with a declared `Content-Length` above the hard ceiling before it reaches a route handler at all — defense-in-depth for future endpoints, not a replacement for the per-handler tiered check (it can't catch a chunked/unlabeled body).

Oversized requests return `413 PAYLOAD_TOO_LARGE` using the standard error envelope; malformed JSON continues to flow through as `null` into each endpoint's existing validator, unchanged from before, so `400 VALIDATION_ERROR` responses stay exactly as they were. `deploy/nginx/awcms-mini.conf.example` now sets `client_max_body_size 10m` to match the application's hard ceiling.
