---
"awcms-mini": minor
---

feat(deploy): add a Varnish edge cache for the staging/production profile, with default-deny cacheability

Repeated reads no longer have to reach the database. `docker-compose.prod.yml`
gains an always-on `cache` service in front of `app`; the LAN-first/offline
profile (`docker-compose.yml`) is deliberately unchanged, since one tenant on
one box gains nothing from an extra hop.

**The cacheability decision lives in the application, not in VCL.** Before this
change the app emitted no `Cache-Control` header at all — safe only while
nothing sat in front of it, because any shared cache (Varnish, a CDN, a
corporate proxy) then falls back to its own heuristics, which for a 200 GET
generally means "store it". In an app that resolves the tenant from the request
Host and authorizes per session, that is exactly how one tenant's page reaches
another. `src/lib/http/cache-policy.ts` now stamps `private, no-store` on every
response that did not explicitly opt in, from the single middleware chokepoint
every response passes through. That protects every intermediary, not just our
own edge.

Two cacheable classes:

- `public` — anonymous and shareable, plain `Cache-Control: public, max-age=N`,
  ceiling 300 s.
- `session` — authenticated and user-scoped. Sent as `Cache-Control: private,
  no-store` for every generic cache, plus a private `X-AWCMS-Edge-Cache` header
  that only our Varnish reads and which it strips before delivery. Ceiling 60 s,
  with zero grace and keep: a stale *authorized* page after a role change,
  suspension, or entitlement expiry is a security problem, not a freshness one.

The cache key always mixes in Host, the locale cookie, and — whenever a session
cookie is present — the session and tenant cookies. A logged-in visitor
therefore gets their own copy of an otherwise-public page. That duplication is
deliberate: the alternative is a key that is correct only if the backend
classification is correct, and a bug there leaks one user's page to another.

Never cached regardless of what the app says: non-GET/HEAD, anything with an
`Authorization` header, `/api/v1/auth/*`, `/login`, `/logout`, `/api/v1/health`,
`/metrics`, and any response carrying `Set-Cookie`.

`bun run varnish:cache:check` starts a real Varnish against a stub backend and
proves the isolation over HTTP — compiling the VCL only proves it parses. Every
assertion was mutation-verified: removing the session component from `vcl_hash`
makes the per-user case fail with user B receiving user A's cached page. It is
not part of `bun run check` because it needs Docker, the same reason the
Playwright suite is separate.

Note for operators: `docker-compose.prod.yml` no longer publishes `app`'s host
port. The edge is the only ingress — publishing both would let a request bypass
the edge and its tenant/session keying entirely.
