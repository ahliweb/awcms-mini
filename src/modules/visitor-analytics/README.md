# Visitor Analytics

Epic: visitor analytics (Issue #617-#624). Privacy-first human visitor
statistics for admin and public routes, in both online and offline/LAN
configurations. This module (`key: visitor_analytics`) is a `type:
"system"` module — platform/observability infrastructure every tenant
shares the mechanism of, the same reasoning as `reporting`/`logging` — not
a tenant-facing business feature. See
`.claude/skills/awcms-mini-visitor-analytics/SKILL.md` for the full
cross-issue context.

## Why a separate module

AWCMS-Mini already has `reporting` (management reporting views) and
`logging` (audit trail). Visitor telemetry does not belong in either:

- **Volume**: a page-view/event stream from every admin and public request
  is orders of magnitude higher-volume than audit events (which are
  emitted only for high-risk actions) or reporting's read-aggregation
  queries.
- **Retention**: visitor events/raw-detail need short, independently
  tunable retention windows (days, not years) distinct from the audit
  trail's compliance-driven retention.
- **Privacy controls**: visitor telemetry touches IP address, user-agent,
  and (optionally) geolocation — data classes `reporting`/`logging` do not
  otherwise handle, needing their own dedicated opt-in flags and a
  raw-detail permission separate from aggregate dashboard access.

## Scope per issue

Issue #617 (this module — `module.ts`, `domain/visitor-analytics-config.ts`):
registers `visitor_analytics` in the trusted code module catalog
(`src/modules/index.ts`) so it syncs into `awcms_mini_modules` via
`bun run modules:sync`, declares the eight permissions from migration 038
(see §Permission seed), and adds the env-based configuration gate (see
§Configuration). **No analytics tables, no middleware collector, no API,
no dashboard UI, no geolocation enrichment, and no rollup/retention jobs
yet** — see §Not yet available below.

Issue #618 (`sql/039_awcms_mini_visitor_analytics_schema.sql`): adds
`awcms_mini_visitor_sessions`, `awcms_mini_visit_events`, and
`awcms_mini_visitor_daily_rollups` — tenant-scoped, `ENABLE`+`FORCE ROW
LEVEL SECURITY` (see §Schema below). **Schema only — no writer yet.**
Nothing inserts into these tables until the middleware collector (#620).

Issue #619 (`domain/visitor-key.ts`, `domain/user-agent.ts`,
`domain/human-classifier.ts`, `domain/path-sanitizer.ts`,
`domain/referrer.ts`): pure, unit-tested helpers for visitor identity,
user-agent parsing, human/bot classification, path/query sanitization,
and referrer extraction (see §Domain helpers below). **Helpers only — not
wired into any request path yet.** Nothing calls these until the
middleware collector (#620).

Issue #620 (`application/collector.ts`, `domain/request-area.ts`,
`domain/client-ip.ts`, `src/middleware.ts`): wires the domain helpers into
the real request lifecycle — collects visitor presence/events for
`/admin/*` and public page requests, fail-open on any error (see
§Collector below). **First issue that actually writes to
`awcms_mini_visitor_sessions`/`awcms_mini_visit_events`.**

Issue #621: analytics API + OpenAPI contract at `/api/v1/analytics`.

Issue #623: trusted online geolocation enrichment.

Issue #622: admin visitor analytics dashboard UI at `/admin/analytics`.

Issue #624: rollup job, retention purge job, readiness checks, and final
docs pass.

## Configuration (`domain/visitor-analytics-config.ts`)

Every `VISITOR_ANALYTICS_*` env var is optional with a privacy-first
default — leaving all of them unset keeps `bun run config:validate`
passing and the module behaving safely for offline/LAN deployments.
`resolveVisitorAnalyticsConfig(env)` is the single entry point later
issues (#619 identity helpers, #620 middleware collector) should call
rather than re-reading `process.env.VISITOR_ANALYTICS_*` themselves.

| Var                                           | Default | Notes                                                                                                                                                             |
| --------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VISITOR_ANALYTICS_ENABLED`                   | `true`  | Master switch. `false` disables collection entirely.                                                                                                              |
| `VISITOR_ANALYTICS_MODE`                      | `basic` | `basic` \| `detailed` (`VISITOR_ANALYTICS_MODES`). Unknown value falls back to `basic`.                                                                           |
| `VISITOR_ANALYTICS_COLLECT_ADMIN`             | `true`  | Collect telemetry for `/admin/*` routes.                                                                                                                          |
| `VISITOR_ANALYTICS_COLLECT_PUBLIC`            | `true`  | Collect telemetry for public routes.                                                                                                                              |
| `VISITOR_ANALYTICS_COLLECT_API`               | `false` | Collect telemetry for `/api/v1/*` calls.                                                                                                                          |
| `VISITOR_ANALYTICS_DETAILED_ENABLED`          | `false` | Reserved for `detailed` mode's richer session/event granularity.                                                                                                  |
| `VISITOR_ANALYTICS_RAW_IP_ENABLED`            | `false` | Store the raw IP address. Privacy-first default: off.                                                                                                             |
| `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED`    | `false` | Reserved — no raw-user-agent column exists yet (migration 039 only has `user_agent_hash` + parsed fields). Currently a no-op regardless of value; see §Collector. |
| `VISITOR_ANALYTICS_GEO_ENABLED`               | `false` | Enable geolocation enrichment (Issue #623). Privacy-first default: off.                                                                                           |
| `VISITOR_ANALYTICS_TRUST_PROXY`               | `false` | Trust `X-Forwarded-For`/similar headers. Only set `true` behind a trusted reverse proxy.                                                                          |
| `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`          | `false` | Trust Cloudflare-specific headers (`CF-Connecting-IP`, `CF-IPCountry`). Only behind Cloudflare.                                                                   |
| `VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS`     | `300`   | Positive integer. Real-time "online now" window.                                                                                                                  |
| `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`      | `90`    | Positive integer.                                                                                                                                                 |
| `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` | `30`    | Positive integer. Shorter than event retention — raw detail is the most sensitive data class.                                                                     |
| `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS`     | `730`   | Positive integer. Aggregated rollups can be kept far longer than raw events.                                                                                      |
| `VISITOR_ANALYTICS_HASH_SALT`                 | `""`    | Optional salt for the pseudonymous visitor fingerprint (Issue #619). Never a real secret here.                                                                    |

`bun run config:validate`'s `checkVisitorAnalyticsConfig` validates
`VISITOR_ANALYTICS_MODE` against `VISITOR_ANALYTICS_MODES` and each
retention/window var against `parsePositiveInt` when set — never against
the raw boolean flags (any value other than the literal string `"true"`
is treated as `false`, the same convention every other boolean env var in
this repo follows).

## Permission seed (migration `038_awcms_mini_visitor_analytics_permissions.sql`, Issue #617)

`module_key = 'visitor_analytics'`:

- `dashboard.read` — read the visitor analytics dashboard.
- `realtime.read` — read real-time/online visitor counts.
- `sessions.read` — read visitor session records.
- `events.read` — read visitor page-view/event records.
- `raw_detail.read` — read raw visitor detail (IP, user-agent), kept
  separate from aggregate dashboard access so an operator can grant
  dashboard visibility without granting raw PII access.
- `settings.read` / `settings.update` — read/update module settings.
- `retention.purge` — purge data past its retention window.

No endpoints or roles are wired to these yet.

## Schema (migration `039_awcms_mini_visitor_analytics_schema.sql`, Issue #618)

Three tenant-scoped tables, all `ENABLE`+`FORCE ROW LEVEL SECURITY` with
the standard `tenant_id = current_setting('app.current_tenant_id')::uuid`
policy. None are soft-deletable (not master/config data) — lifecycle is
retention-based purge (Issue #624's job), the same shape as
`awcms_mini_audit_events`.

- **`awcms_mini_visitor_sessions`** — one row per visitor presence
  session (`visitor_key_hash`, `area`, `first_seen_at`/`last_seen_at`,
  already-parsed browser/device/geo fields). `ip_address` (raw `inet`)
  and `ip_hash`/`user_agent_hash` are all nullable — raw IP is only ever
  populated when `VISITOR_ANALYTICS_RAW_IP_ENABLED=true`.
  `login_identifier_snapshot` is nullable and must never be set for
  anonymous public visitors.
- **`awcms_mini_visit_events`** — one row per page-view/API call
  (`method`, `status_code`, `path_sanitized`, `human_status`, plus
  `user_agent_parsed`/`geo` `jsonb` catch-alls that only ever hold
  parsed/derived values, never raw request data). Optional FKs to
  `visitor_session_id`/`identity_id`.
- **`awcms_mini_visitor_daily_rollups`** — pre-aggregated daily stats,
  `PRIMARY KEY (tenant_id, date, area)` doubling as the future rollup
  job's upsert target. No separate `(tenant_id, date, area)` index is
  created — the primary key's backing index already covers it.

No request body, cookie, Authorization header, password reset token,
OAuth code, or query-string secret is ever stored in any column,
including the two `jsonb` catch-alls. Verified by
`tests/integration/visitor-analytics-schema.integration.test.ts`'s
column-name scan and per-table RLS isolation/fail-closed tests.

## Domain helpers (Issue #619)

Pure, unit-tested functions under `domain/` — no request/cookie I/O, no
database writes. The middleware collector (#620) is the first caller.

- **`visitor-key.ts`** — `generateVisitorKey()` (CSPRNG UUID),
  `isValidVisitorKey()`/`resolveVisitorKey()` (reuse a valid existing
  cookie value or mint a new one — never trusts a forged/non-UUID value
  as-is), and `hashVisitorKey`/`hashIpAddress`/`hashUserAgent` (HMAC-SHA256
  keyed by `VISITOR_ANALYTICS_HASH_SALT`, not plain SHA256 — a deployment
  salt prevents cross-deployment correlation via precomputed hash tables,
  unlike `profile-identity/domain/identifier.ts`'s deliberately unsalted
  `hashIdentifier`).
- **`user-agent.ts`** — `parseUserAgent()` returns browser name/major
  version, OS name, `deviceType` (`desktop`/`mobile`/`tablet`/`bot`/
  `unknown`), and bot detection (`isBotUserAgent()`). No UA-parsing
  library dependency — a compact regex table covers common browser/OS/bot
  families; missing an exotic UA degrades to `"unknown"`, never a wrong
  guess presented as certain. **Never a security/authorization decision
  point** — a spoofed UA trivially defeats it, which is acceptable for
  analytics but never for access control.
- **`human-classifier.ts`** — `classifyHumanStatus()` (tri-state
  `human`/`bot`/`unknown` for `awcms_mini_visit_events.human_status`: bot
  UA always wins; an authenticated session with any non-bot UA is human;
  an unauthenticated request with an unrecognized UA is `unknown`, never
  defaulted to human) and `classifySessionHumanity()` (boolean
  `is_human`/`bot_reason` for `awcms_mini_visitor_sessions`, which has no
  `unknown` tri-state column).
- **`path-sanitizer.ts`** — `sanitizePath()` strips the issue's minimum
  sensitive query parameter list (`token`, `code`, `password`, `secret`,
  `email`, `phone`, `authorization`, `access_token`, `refresh_token`,
  `reset_token`, `mfaChallengeToken`, matched case-insensitively) before a
  path may ever reach `path_sanitized`; `isTrackablePath()` excludes
  static assets, `/_astro/*` build output, favicon, health endpoints, and
  OpenAPI/AsyncAPI spec paths from pageview counting.
- **`referrer.ts`** — `extractReferrerDomain()` returns a bare lowercase
  hostname only (never path/query/fragment, which routinely carry the
  referring page's own tokens), `null` for anything unparseable or a
  non-http(s) scheme.

Test: `tests/unit/visitor-analytics-visitor-key.test.ts`,
`-user-agent.test.ts` (20+ real user-agent strings — desktop, mobile,
tablet, tablet-via-Android-without-Mobile-token, 13 bot/crawler
signatures, unknown/gibberish), `-human-classifier.test.ts`,
`-path-sanitizer.test.ts`, `-referrer.test.ts`.

## Collector (Issue #620, `application/collector.ts` + `src/middleware.ts`)

The only writer of `awcms_mini_visitor_sessions`/`awcms_mini_visit_events`.
`src/middleware.ts` calls `collectVisitorTelemetry` after `next()` resolves
(on both its pre-admin and `/admin/*` branches), so the response status
code is already known.

**`VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED` is currently a no-op**:
`collector.ts` never reads it, and neither `awcms_mini_visitor_sessions`
nor `awcms_mini_visit_events` (migration 039) has a raw-user-agent
column — only `user_agent_hash` and the derived `user_agent_parsed`
jsonb exist. Unlike `VISITOR_ANALYTICS_RAW_IP_ENABLED` (genuinely gates
the real `ip_address` column), setting this flag `true` today changes
nothing. A future issue must either wire it to a new column or this flag
should be removed rather than left silently non-functional.

- **Gate**: `shouldCollectRequest` (pure, unit-tested) — `false` unless
  `VISITOR_ANALYTICS_ENABLED=true`, the path is trackable
  (`isTrackablePath`), and the per-area flag is on
  (`VISITOR_ANALYTICS_COLLECT_ADMIN` for `/admin/*`,
  `VISITOR_ANALYTICS_COLLECT_API` for anything under `/api`,
  `VISITOR_ANALYTICS_COLLECT_PUBLIC` for everything else, including
  `/login` — a page render, not an API call).
- **Area classification**: `domain/request-area.ts`'s `determineArea` —
  `admin`/`setup`/`auth`/`api`/`public`, matching migration 039's `area`
  CHECK constraint exactly. `setup`/`auth` are sub-classifications of API
  space (`/api/v1/setup/*`, `/api/v1/auth/*`), both still gated by
  `COLLECT_API`.
- **Tenant resolution**: `/admin/*` uses `ssrContext.tenantId` (already
  resolved by the existing auth guard). Every other area uses
  `resolvePublicTenantFromRequest` (Issue #559) — best-effort; a request
  whose tenant can't be resolved (unknown host, no public routing
  configured) is simply not collected, never a hard failure.
- **Visitor cookie**: `awcms_mini_visitor_key`, `httpOnly`/`sameSite=lax`/
  2-year `maxAge`, set only when a request is actually collected (not on
  every request). Value resolved via `resolveVisitorKey` (#619) — reuses
  a valid existing cookie, mints a new one otherwise.
- **Client IP**: `domain/client-ip.ts`'s `resolveAnalyticsClientIp` — a
  deliberately more conservative sibling of `lib/security/rate-limit.ts`'s
  `resolveClientIp`; only trusts `CF-Connecting-IP`/`X-Forwarded-For` when
  `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`/`_TRUST_PROXY` are explicitly on,
  else uses `clientAddress` (direct connection) only. Returns `null`
  (never a fake placeholder) when nothing is resolvable.
- **Session find-or-create**: looked up by
  `(tenant_id, visitor_key_hash, area)` (migration 040's new lookup
  index). A session found within `VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS`
  of `last_seen_at` is reused — its `last_seen_at`/browser/device fields
  are refreshed, but only if the last write was itself ≥30s ago (write
  throttle, issue's own "Recommended write-throttle behavior"); a session
  older than the online window starts a new row instead. The event insert
  itself is never throttled — always one row per collected request.
  `login_identifier_snapshot` is deliberately always `null` (nullable
  display convenience, not populated in this issue — no functional
  requirement forces it, and it would need an extra identities lookup on
  every new session).
- **Fail-open**: `collectVisitorTelemetry` never throws — every failure
  is caught and logged as `log("warning", "visitor_analytics.collector.failed", {correlationId, tenantId, moduleKey, error})`,
  never surfaced to the request. Uses `withTenant`'s
  `workClass: "background_sync"` (lowest-priority DB work class, doc 16)
  so a saturated pool serves real interactive/reporting work first.
- **FK safety** (Issue #618 security-audit follow-up, closed here):
  `identityId` is always the caller's own server-derived authenticated
  identity (`ssrContext.identityId` for `/admin/*`, `null` for every
  public request) — never a client-supplied value. `visitor_session_id`
  is always resolved from a row this function itself just found/created
  inside its own tenant-scoped transaction — never from a raw
  client-supplied UUID. See the skill's §Schema entry for the full
  cross-tenant-existence-oracle reasoning this closes.

Test: `tests/unit/visitor-analytics-collector.test.ts` (`shouldCollectRequest`,
pure), `tests/unit/visitor-analytics-request-area.test.ts`,
`tests/unit/visitor-analytics-client-ip.test.ts`,
`tests/integration/visitor-analytics-collector.integration.test.ts`
(session/event creation, sensitive-param stripping, bot classification,
raw-IP opt-in, session throttle/reuse, session-boundary rollover after the
online window, non-trackable-path no-op, fail-open on an invalid
tenantId, authenticated admin session). Also manually smoke-tested against
a real dev server + Postgres (setup wizard → login → `/admin` → real
session/event rows with correct `identity_id`/`area`; `/`→ public session;
static asset and default-off `/api/v1/health` → no rows written).

## Not yet available

- REST API (`/api/v1/analytics/*`) — Issue #621.
- Admin dashboard UI (`/admin/analytics`) — Issue #622.
- Geolocation enrichment — Issue #623.
- Rollup/retention purge jobs — Issue #624.

The `api.basePath`/navigation `path` in `module.ts` are pre-declared ahead
of their landing issues (same convention `tenant_domain`'s descriptor
followed ahead of Issue #562) — no route exists at either path yet.
