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

Issue #621 (`src/pages/api/v1/analytics/*`, `application/analytics-queries.ts`,
`application/session-directory.ts`, `application/event-directory.ts`,
`application/retention-purge.ts`, `domain/analytics-range.ts`,
`domain/analytics-response-shaping.ts`): eleven REST endpoints — realtime
presence, range-bounded summary/pages/devices/locations/security
aggregates, keyset-paginated sessions/events, settings, and on-demand
retention purge (see §API below). First issue exposing this module's data
through authenticated APIs.

Issue #623 (`domain/geo-enrichment.ts`, hardened `domain/client-ip.ts`):
optional country-code enrichment from Cloudflare's `CF-IPCountry` header,
gated behind both `VISITOR_ANALYTICS_GEO_ENABLED` and
`VISITOR_ANALYTICS_TRUST_CLOUDFLARE` — never an external network call
(see §Geo enrichment below). Also hardens `resolveAnalyticsClientIp`
against ambiguous multi-value forwarded headers. **First issue that
populates `visitor_sessions.country_code`/`visit_events.geo` with a real
value** — `/api/v1/analytics/locations` (Issue #621) has real data from
here on for deployments that opt in.

Issue #622 (`src/pages/admin/analytics.astro`,
`domain/dashboard-view.ts`): admin visitor analytics dashboard UI at
`/admin/analytics` — surfaces #621's endpoints only (see §Dashboard UI
below).

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

## API (Issue #621, `src/pages/api/v1/analytics/*`)

All eleven endpoints require a bearer session + tenant context and run
`authorizeInTransaction` (ABAC default-deny) before touching any data —
denial is always `403 ACCESS_DENIED`, never empty/zeroed analytics data.

| Method    | Path                                | Guard                                 | Notes                                                                                                                                               |
| --------- | ----------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET       | `/api/v1/analytics/realtime`        | `realtime.read`                       | Online-now counts by area/human, `VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS` window.                                                                  |
| GET       | `/api/v1/analytics/summary`         | `dashboard.read`                      | `range=24h\|7d\|30d\|12m` (default `7d`), strictly validated (`400 VALIDATION_ERROR`).                                                              |
| GET       | `/api/v1/analytics/pages`           | `dashboard.read`                      | Top paths by human pageviews.                                                                                                                       |
| GET       | `/api/v1/analytics/devices`         | `dashboard.read`                      | Browser + device-type breakdown.                                                                                                                    |
| GET       | `/api/v1/analytics/locations`       | `dashboard.read`                      | Country breakdown — empty until Issue #623 populates `geo`.                                                                                         |
| GET       | `/api/v1/analytics/security`        | `dashboard.read`                      | Bot/crawler traffic breakdown (by `bot_reason`, by area).                                                                                           |
| GET       | `/api/v1/analytics/sessions`        | `sessions.read` (+ `raw_detail.read`) | Keyset-paginated (limit 50, `last_seen_at DESC`).                                                                                                   |
| GET       | `/api/v1/analytics/events`          | `events.read` (+ `raw_detail.read`)   | Keyset-paginated (limit 50, `occurred_at DESC`).                                                                                                    |
| GET/PATCH | `/api/v1/analytics/settings`        | `settings.read`/`.update`             | Reuses Module Management's generic settings storage (Issue #516), gated by this module's own permissions instead of `module_management.settings.*`. |
| POST      | `/api/v1/analytics/retention/purge` | `retention.purge`                     | Requires `Idempotency-Key`; `critical`-severity audit event.                                                                                        |

**Raw-detail gating** (`domain/analytics-response-shaping.ts`): `sessions`/
`events` always include non-raw fields (browser/device/OS, area,
`human_status`, timestamps) for anyone with `sessions.read`/`events.read`
alone. `ipHash`/`ipAddress`/`userAgentHash`/`loginIdentifierSnapshot`
are `null` unless the caller _also_ holds
`visitor_analytics.raw_detail.read` — checked via
`auth.grantedPermissionKeys.has("visitor_analytics.raw_detail.read")`
after the primary guard passes, never a substitute for it.

**Aggregate queries** (`application/analytics-queries.ts`) compute
directly from raw `awcms_mini_visit_events`/`awcms_mini_visitor_sessions`
rows, not `awcms_mini_visitor_daily_rollups`. This was true by necessity
when written (the rollup job didn't exist yet, so the table was always
empty) and remains the deliberate choice now that Issue #624's
`bun run analytics:rollup` populates it: raw events are always current
for "today", while rollups only cover fully-finished past days.
Switching `fetchAnalyticsSummary` to read rollups for older ranges (a
performance optimization, not a correctness requirement — raw queries
already return the right numbers) is out of scope for #624 too and
remains open future work, not something #624's acceptance criteria asked
for.

**Retention purge** (`application/retention-purge.ts`) is a real,
independently-callable function using Issue #617's config as cutoffs —
not a stub. Issue #624's scheduled job (`bun run analytics:purge`,
`scripts/visitor-analytics-purge.ts`, mirroring `logs:audit:purge`) calls
this exact function (via `purgeVisitorAnalyticsForAllTenants`) for every
active tenant rather than re-deriving the purge rules. See that file's
own doc comment for the four-cutoff design (event delete / raw-detail
clear / session delete / rollup delete) and why session delete is safe
to run after event delete.

Test: `tests/unit/visitor-analytics-range.test.ts`,
`-response-shaping.test.ts`,
`tests/integration/visitor-analytics-api.integration.test.ts` (auth guard,
ABAC deny across every guarded endpoint, realtime counts, summary
aggregation + range validation, raw-detail gating both ways, keyset
pagination across a 55-row page boundary + malformed-cursor rejection,
settings GET/PATCH + secret-shaped-key rejection, retention purge
idempotency + real deletion + audit event).

## Geo enrichment (Issue #623, `domain/geo-enrichment.ts`)

Country code only, from Cloudflare's `CF-IPCountry` header — never an
external network call (binding constraint). Gated behind **both**
`VISITOR_ANALYTICS_GEO_ENABLED` and `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`;
either flag off returns all-null. Region/city/timezone always stay
`null` in this issue — no local/offline GeoIP database is configured
(out of scope: "Paid GeoIP integration"); a future issue can add one
without changing this function's signature.

`src/middleware.ts` calls `resolveGeoEnrichment` alongside
`resolveAnalyticsClientIp` and passes the result into
`collectVisitorTelemetry`'s new `geo` field, which
`application/collector.ts` writes to both
`awcms_mini_visitor_sessions.country_code`/`region`/`city`/`timezone`
and `awcms_mini_visit_events.geo` (jsonb `{countryCode, region, city,
timezone}` — the same shape `application/analytics-queries.ts`'s
`fetchTopCountries` already reads via `geo->>'countryCode'`, so
`GET /api/v1/analytics/locations` (Issue #621) starts returning real
data the moment a deployment opts in, with no change needed on the API
side).

**Ambiguous-header hardening** (`domain/client-ip.ts`, also this issue):
`resolveAnalyticsClientIp` now treats a forwarded header (`X-Forwarded-For`
or `CF-Connecting-IP`) carrying more than one comma-separated value as an
anomaly — logs a warning and falls through to the next source, exactly
as if that trust flag were `false` for this one request, mirroring
`lib/tenant/public-host-tenant-resolver.ts`'s `X-Forwarded-Host` handling
in the tenant-domain-routing epic. A correctly-configured trusted proxy
must _overwrite_, never _append to_, these headers (same operational
contract as `PUBLIC_TRUST_PROXY`, doc 18), so a real trusted proxy never
produces more than one value here either — this is not a functional
regression for any correctly-configured deployment.

**Post-review fix, this issue**: `application/collector.ts`'s
`user_agent_parsed`/`geo` jsonb writes previously built the value with
`JSON.stringify(...)` before an explicit `::jsonb` cast — this stores
byte-identical rows, but Bun.SQL then decodes every later `SELECT` of
that column as a raw JSON **string**, not a parsed object (a real,
previously-undetected bug since Issue #620, silently affecting
`GET /api/v1/analytics/events`'s `userAgentParsed`/`geo` response fields
since Issue #621 — see the memory note `bun-sql-jsonb-stringify-trap` for
the full empirical writeup). Fixed by binding the plain object directly
as the query parameter instead. Regression-tested both at the collector
level and through the real HTTP `/events`/`/locations` response shape.

## Dashboard UI (Issue #622, `src/pages/admin/analytics.astro`)

`/admin/analytics`, gated by `visitor_analytics.dashboard.read`
(navigation entry pre-declared in `module.ts` since Issue #617). UI-only:
adds no new endpoint/permission, and never queries
`awcms_mini_visitor_sessions`/`awcms_mini_visit_events` directly — every
number/table is loaded client-side from the real
`GET /api/v1/analytics/*` endpoints (Issue #621) via a new `fetchJson`
helper (`src/lib/ui/admin-form-client.ts`), deliberately NOT the
SSR-calls-the-application-layer-directly convention
`admin/security.astro`/`admin/sync.astro` use — server-side ABAC
(`authorizeInTransaction`) stays the only real enforcement point.

- **Sections**: online-now cluster (`realtime.read`, its own
  permission — hidden entirely if the caller lacks it, same
  per-section-permission convention `admin/sync.astro` established),
  three always-shown 24h/7d/30d human-visitor summary cards (three
  parallel `/summary` calls, independent of the range filter below), a
  range-scoped cluster (top pages/devices/locations/security, all
  re-fetched together on range change), and an active-sessions table
  (`sessions.read`, its own permission).
- **Raw-detail gating**: never re-derived here. `GET
/api/v1/analytics/sessions` already returns `ipAddress`/`ipHash`/
  `userAgentHash`/`loginIdentifierSnapshot` as `null` for a caller
  without `raw_detail.read` (Issue #621's own
  `shapeVisitorSession`) — the client script renders exactly that
  response (`domain/dashboard-view.ts`'s `buildSessionRowCells`/
  `displayOrPlaceholder`: a `null` renders as a placeholder dash, never
  the literal string `"null"`). The dashboard additionally hides the
  four raw-detail _columns_ entirely when the caller's own SSR-known
  permission set lacks `raw_detail.read` — a presentation nicety (avoids
  a wall of placeholder dashes), not a second security decision; it can
  never leak a value the API did not already return. Verified live
  against a real dev server + Postgres: an owner (has `raw_detail.read`)
  sees a real `ipHash` value in `GET /sessions`, a caller with only
  `dashboard.read`/`sessions.read` sees `null` for the same row from the
  API itself, and the dashboard's rendered table has no raw-detail
  columns at all for that caller.
- **Filter scope — a deliberate, documented limitation**: only `range`
  (`24h|7d|30d|12m`) is a real API query parameter (`/summary`, `/pages`,
  `/devices`, `/locations`, `/security`). No aggregate endpoint accepts an
  `area` or visitor-type parameter (Issue #621 as shipped never added
  one — doing so would be an API change, out of scope for this UI-only
  issue), so the "Area"/"Visitor type" filters instead narrow the
  active-sessions table's already-fetched rows client-side
  (`matchesAreaFilter`/`matchesVisitorTypeFilter`,
  `domain/dashboard-view.ts`) — a real, useful filter, just scoped to the
  one section that already carries per-row area/human-status data. A
  future issue that adds `area`/visitor-type query parameters to the
  aggregate endpoints could widen this; not done here to stay atomic to
  this issue's own scope ("API implementation" is explicitly out of
  scope for #622).
- **Geolocation gate**: the Location section renders a safe "disabled"
  `StateNotice` instead of a table when
  `VISITOR_ANALYTICS_GEO_ENABLED && VISITOR_ANALYTICS_TRUST_CLOUDFLARE`
  is not both `true` — read directly from
  `resolveVisitorAnalyticsConfig()` (Issue #617, env-only, no I/O; not a
  database access and not a second copy of a security decision, it only
  decides whether to render/fetch a section that would otherwise always
  come back empty).
- **States**: loading/empty/error resolved by
  `domain/dashboard-view.ts`'s `resolveSectionState` — a failed fetch
  always resolves to `"error"`, never silently presented as `"empty"`.
  Errors shown are always the same safe, translated messages every other
  admin mutation form already uses (`buildClientErrorMessages`), never a
  raw stack trace.
- **Tests**: `tests/unit/visitor-analytics-dashboard-view.test.ts` (raw-
  detail-null formatting/no-leak, section-state resolution, area/visitor-
  type filter predicates — all pure, no browser needed) and two
  Playwright specs, `tests/e2e/admin-analytics-access-denied.e2e.ts`
  (no-role user sees only the denied state, dashboard markup absent from
  the DOM) and `tests/e2e/admin-analytics-dashboard.e2e.ts` (owner sees
  the full shell + raw-detail columns; a restricted `dashboard.read` +`sessions.read`-only viewer sees the same tenant-wide session row
  populated with no raw-detail columns and no `sha256:`-prefixed hash
  value anywhere in the rendered table).

## Rollup job (Issue #624, `application/rollup.ts` + `scripts/visitor-analytics-rollup.ts`)

`bun run analytics:rollup` aggregates `awcms_mini_visit_events` into
`awcms_mini_visitor_daily_rollups`, one row per `(tenant, date, area)`,
for every `active` tenant.

- **Idempotent by construction**: `rollupVisitorAnalyticsForDate` fully
  recomputes each area's totals from raw events for the requested date
  and UPSERTs (`ON CONFLICT (tenant_id, date, area) DO UPDATE SET ... =
EXCLUDED...`) — rerunning the same date any number of times converges on
  the same row, it never increments an existing one.
- **Deliberately not reusing `application/analytics-queries.ts`'s
  top-N helpers verbatim** — those are cumulative-since-`start` (no
  upper bound) and tenant-wide (no `area` filter), the shape the live
  dashboard summary needs (Issue #621). Rollup needs a closed
  `[dayStart, dayEnd)` window AND a per-`area` split (the rollup table's
  own primary key), so `application/rollup.ts` implements its own
  day+area-scoped top-N queries following the exact same SQL-safety
  pattern (allow-listed jsonb column/key before any `tx.unsafe` string
  interpolation).
- **Columns populated**: `human_unique_visitors`, `human_pageviews`,
  `bot_pageviews`, `authenticated_unique_users`, `public_unique_visitors`
  (only meaningful — non-zero — for the `area='public'` row),
  `admin_unique_users` (only meaningful for the `area='admin'` row), and
  four top-10 arrays (`top_paths`/`top_browsers`/`top_devices`/
  `top_countries`).
- **An area with zero events for a date gets no row** — not a zero-value
  row, matching the underlying `awcms_mini_visit_events` table itself.
- **CLI**: `--date=YYYY-MM-DD` (single date), or
  `--start-date=.../--end-date=...` (inclusive range, for backfill). No
  argument defaults to "yesterday" (UTC) — the day a daily cron run just
  after UTC midnight would want to finalize.

Test: `tests/integration/visitor-analytics-rollup.integration.test.ts`
(per-area aggregate + top-N correctness, idempotent rerun with a THIRD
rerun after a new event proving this is a real recompute rather than a
frozen cache, area-with-no-events gets no row, events outside the
requested date excluded).

## Retention purge job (Issue #624, `scripts/visitor-analytics-purge.ts`)

`bun run analytics:purge` iterates every `active` tenant and calls
`purgeVisitorAnalyticsData` (§API above) DIRECTLY via the exported
`purgeVisitorAnalyticsForAllTenants` — never re-deriving the four
retention cutoffs a second time, exactly as that file's own doc comment
requires. Only a tenant where the purge actually deleted/cleared
something gets its own `critical` `retention_purged` audit event
(attributes: the four safe row counts only, never raw event/session
data) — a tenant with nothing yet past retention produces no audit
noise. No extra batching layer is added on top of what
`purgeVisitorAnalyticsData` already does (one bounded set of statements
per tenant, already reviewed/tested in Issue #621).

Test: `tests/integration/visitor-analytics-purge.integration.test.ts` —
deliberately does NOT re-test the four retention cutoffs themselves
(already covered end-to-end by
`tests/integration/visitor-analytics-api.integration.test.ts`'s
`POST /api/v1/analytics/retention/purge` tests, which call the exact
same `purgeVisitorAnalyticsData` function); only covers what the script
adds — multi-tenant iteration, summed totals, and per-tenant audit
gating (only a tenant with an actual effect gets audited).

## Config and readiness checks (Issue #624, `scripts/security-readiness.ts`)

`scripts/validate-env.ts`'s `checkVisitorAnalyticsConfig` (Issue #617)
stays shape-only (enum/positive-int format) — Issue #624 adds five
cross-field SAFETY checks to `bun run security:readiness` instead,
following the same `validate-env.ts` (shape) vs `security-readiness.ts`
(safety/severity judgment) split every other gated feature in this repo
already uses (`checkOnlineAuthSecurityConfig`/`Ready`,
`checkTurnstileConfig`/`Ready`, etc.). All five reuse
`resolveVisitorAnalyticsConfig` — never re-read
`process.env.VISITOR_ANALYTICS_*` directly:

| Check                                             | Severity | Fails when                                                                    |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `checkVisitorAnalyticsRawIpRetentionReady`        | critical | Raw IP enabled and raw-detail retention exceeds event retention               |
| `checkVisitorAnalyticsRawUserAgentRetentionReady` | warning  | Raw user-agent enabled (still a no-op today) and the same retention is unsafe |
| `checkVisitorAnalyticsGeoTrustedSourceReady`      | critical | Geo enabled without `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`                      |
| `checkVisitorAnalyticsRetentionOrderingReady`     | warning  | Raw detail retention > event retention, OR rollup retention < event retention |
| `checkVisitorAnalyticsHashSaltReady`              | warning  | Module enabled and `VISITOR_ANALYTICS_HASH_SALT` is empty                     |

Every default (privacy-first, nothing set) passes all five checks
cleanly — only `critical` findings block `security:readiness`'s exit
code; `warning` findings are reported but never block. Full rationale
per check, plus a compliance mapping (UU PDP, PP PSTE, ISO/IEC
27001/27002/27005/27701, OWASP ASVS, OWASP Logging Cheat Sheet), lives in
`docs/awcms-mini/visitor-analytics.md`.

Test: `tests/security-readiness.test.ts` (unit, one `describe` block per
check above, both the pass/fail branches for each).

## Documentation (Issue #624)

- `docs/awcms-mini/visitor-analytics.md` (new) — operational guide:
  offline/LAN vs full-online vs trusted-proxy/Cloudflare mode, retention
  table per column, rollup/purge job behavior, config/readiness check
  table, and the full compliance mapping.
- `docs/awcms-mini/18_configuration_env_reference.md` §Visitor
  analytics — documents the five new cross-field readiness rules
  alongside the existing shape-only `config:validate` rules.
- `docs/awcms-mini/deployment-profiles.md` — new §Visitor analytics
  section (per-profile guidance) and two new rows in §Job registry
  lainnya (`analytics:rollup`/`analytics:purge`).
- `docs/awcms-mini/20_threat_model_security_architecture.md` — new
  §Standar tambahan dipicu epic visitor analytics section.
- `docs/awcms-mini/04_erd_data_dictionary.md` — retention table rows and
  the module's own section updated to reflect the epic as complete
  rather than "fast-follow Issue #624".

The `api.basePath`/navigation `path` in `module.ts` were pre-declared in
`module.ts` ahead of their landing issues (same convention
`tenant_domain`'s descriptor followed ahead of Issue #562) — both are now
real: the API (Issue #621) and the dashboard (Issue #622) have shipped.

With Issue #624 complete, every issue in the visitor analytics epic
(#617-#624) is now done.
