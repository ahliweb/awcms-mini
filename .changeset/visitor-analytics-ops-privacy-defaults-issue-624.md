---
"awcms-mini": minor
---

Close out the visitor analytics operational/privacy loop (Issue #624,
epic #679 platform-hardening) with a 2026-07-11 repository audit
addendum: `VISITOR_ANALYTICS_ENABLED` now defaults to `false` — a fresh
installation collects no visitor telemetry at all until an operator
explicitly opts in (`.env.example`, `src/lib/config/registry.ts`, and
`VISITOR_ANALYTICS_DEFAULTS` all updated together). Existing deployments
that already set `VISITOR_ANALYTICS_ENABLED=true` explicitly are
completely unaffected; deployments relying on the previous implicit
default must add the var explicitly to keep collecting after upgrading
(see `docs/awcms-mini/visitor-analytics.md` §Default opt-in dan upgrade
path for the full migration note — no data migration or schema change is
involved, this is config-only).

The anonymous `awcms_mini_visitor_key` cookie's lifetime is now
configurable via `VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS` (30 days
by default, replacing a previous hardcoded ~2-year constant), and is now
actively revoked (deleted) the moment the module is disabled — a new
`bun run security:readiness` check
(`checkVisitorAnalyticsVisitorKeyCookieTtlReady`) flags an unusually long
configured TTL. No cookie is ever set, and no session/event row is ever
written, while the module is disabled — verified by new pure unit tests
(`domain/visitor-key-cookie.ts`'s `shouldRevokeVisitorKeyCookie`/
`planVisitorKeyCookie`).

Documentation updated across `docs/awcms-mini/visitor-analytics.md`
(new §Default opt-in dan upgrade path and §Cookie anonim sections, a
data-subject deletion/anonymization mapping under UU PDP, and an
ISO/IEC 27701:2025 reference update), `18_configuration_env_reference.md`,
`deployment-profiles.md`, `20_threat_model_security_architecture.md`, the
`visitor-analytics` module README, and the
`awcms-mini-visitor-analytics` skill.
