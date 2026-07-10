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

Issue #619: visitor identity, user-agent, and human/bot classification
helpers.

Issue #620: middleware telemetry collection (admin + public routes).

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

| Var                                           | Default | Notes                                                                                           |
| --------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `VISITOR_ANALYTICS_ENABLED`                   | `true`  | Master switch. `false` disables collection entirely.                                            |
| `VISITOR_ANALYTICS_MODE`                      | `basic` | `basic` \| `detailed` (`VISITOR_ANALYTICS_MODES`). Unknown value falls back to `basic`.         |
| `VISITOR_ANALYTICS_COLLECT_ADMIN`             | `true`  | Collect telemetry for `/admin/*` routes.                                                        |
| `VISITOR_ANALYTICS_COLLECT_PUBLIC`            | `true`  | Collect telemetry for public routes.                                                            |
| `VISITOR_ANALYTICS_COLLECT_API`               | `false` | Collect telemetry for `/api/v1/*` calls.                                                        |
| `VISITOR_ANALYTICS_DETAILED_ENABLED`          | `false` | Reserved for `detailed` mode's richer session/event granularity.                                |
| `VISITOR_ANALYTICS_RAW_IP_ENABLED`            | `false` | Store the raw IP address. Privacy-first default: off.                                           |
| `VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED`    | `false` | Store the raw user-agent string. Privacy-first default: off.                                    |
| `VISITOR_ANALYTICS_GEO_ENABLED`               | `false` | Enable geolocation enrichment (Issue #623). Privacy-first default: off.                         |
| `VISITOR_ANALYTICS_TRUST_PROXY`               | `false` | Trust `X-Forwarded-For`/similar headers. Only set `true` behind a trusted reverse proxy.        |
| `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`          | `false` | Trust Cloudflare-specific headers (`CF-Connecting-IP`, `CF-IPCountry`). Only behind Cloudflare. |
| `VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS`     | `300`   | Positive integer. Real-time "online now" window.                                                |
| `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`      | `90`    | Positive integer.                                                                               |
| `VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS` | `30`    | Positive integer. Shorter than event retention — raw detail is the most sensitive data class.   |
| `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS`     | `730`   | Positive integer. Aggregated rollups can be kept far longer than raw events.                    |
| `VISITOR_ANALYTICS_HASH_SALT`                 | `""`    | Optional salt for the pseudonymous visitor fingerprint (Issue #619). Never a real secret here.  |

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

## Not yet available

- Any data collection — Issue #620 (middleware).
- Identity/UA/bot classification helpers — Issue #619.
- REST API (`/api/v1/analytics/*`) — Issue #621.
- Admin dashboard UI (`/admin/analytics`) — Issue #622.
- Geolocation enrichment — Issue #623.
- Rollup/retention purge jobs — Issue #624.

The `api.basePath`/navigation `path` in `module.ts` are pre-declared ahead
of their landing issues (same convention `tenant_domain`'s descriptor
followed ahead of Issue #562) — no route exists at either path yet.
